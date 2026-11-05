import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const BASE = "https://new1.moviesdrive.cyou";
const TYPESENSE = `${BASE}/search.php`;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || "900", 10) * 1000;

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";
const MD_HEADERS = {
  "user-agent": UA,
  accept: "*/*",
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
  referer: `${BASE}/search.html`,
};

const http = axios.create({ timeout: 25000, headers: MD_HEADERS, maxRedirects: 10, validateStatus: (s) => s >= 200 && s < 400 });

const CACHE = new Map();
function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL) { CACHE.delete(key); return null; }
  return v.v;
}
function cacheSet(key, val) {
  CACHE.set(key, { v: val, t: Date.now() });
  return val;
}

function unescapeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

function extractQuality(text) {
  if (!text) return null;
  const m = text.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return raw === "4k" ? "2160" : raw.replace("p", "");
}

function extractSizeGb(text) {
  if (!text) return null;
  const m = text.match(/\[([\d.]+)\s*(gb|mb)\]/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  return m[2].toLowerCase() === "gb" ? num : num / 1024;
}

// ───────────────────────── Search ─────────────────────────
async function mdSearch(q, page = 1) {
  const key = `search:${q}:${page}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const cleanQ = q.replace(/-/g, " ").trim();
  const { data } = await http.get(TYPESENSE, { params: { q: cleanQ, page } });
  const hits = (data.hits || []).map((h) => {
    const d = h.document || {};
    return {
      title: d.post_title,
      permalink: new URL(d.permalink || "", BASE).toString(),
      id: d.id,
    };
  });
  return cacheSet(key, { found: data.found || 0, results: hits });
}

// ───────────────────────── Post Scrape & Folder Resolve ─────────────────────────
async function mdPostLinks(permalink) {
  const url = permalink.startsWith("http") ? permalink : new URL(permalink, BASE).toString();
  const key = `post:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const { data: raw } = await http.get(url);
  const doc = unescapeHtml(raw);
  const $ = cheerio.load(doc);

  const titleMatch = doc.match(/<h1 class="post-title">([^<]+)<\/h1>/);
  const title = titleMatch ? titleMatch[1].trim() : null;
  const isSeries = /season\s*\d+/i.test(title || "");

  const options = [];
  let currentSeason = null;
  let currentQuality = null;
  const rawLinks = [];

  $("body").find("h1, h2, h3, h4, h5, h6, p, div, a").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;

    if (tag !== "a") {
      if (isSeries) {
        const seasonMatch = text.match(/Season\s+(\d+)/i);
        if (seasonMatch) currentSeason = seasonMatch[1];
      }
      const qMatch = extractQuality(text);
      if (qMatch) currentQuality = qMatch;
      return;
    }

    const href = $(el).attr("href");
    if (!href || !href.startsWith("http")) return;
    if (!href.includes("mdrive.lol") && !href.includes("hubcloud")) return;
    
    const lower = text.toLowerCase();
    if (!lower.includes("zip") && !lower.includes("episode") && !lower.match(/\d{3,4}p/)) return;

    const btnQuality = extractQuality(text) || currentQuality;
    
    rawLinks.push({
      label: text,
      url: href,
      quality: btnQuality,
      mode: lower.includes("zip") ? "zip" : "single",
      size_gb: extractSizeGb(text),
      season: isSeries ? currentSeason : null,
    });
  });

  const folderCache = {};

  for (const link of rawLinks) {
    if (link.url.includes("search-recover.php")) {
      try {
        const urlObj = new URL(link.url);
        const b64q = urlObj.searchParams.get("q");
        const searchQuery = b64q ? Buffer.from(b64q, 'base64').toString('utf-8') : "";
        
        if (!folderCache[searchQuery]) {
          const apiUrl = link.url.replace(/\/drive\/search-recover\.php.*/, "/drive/search-recover.php");
          const fromAc = urlObj.searchParams.get("from_ac") || "";
          const { data: apiData } = await http.get(apiUrl, {
            params: { api: 'search', q: searchQuery, page: 1, from_ac: fromAc }
          });
          folderCache[searchQuery] = (apiData && apiData.hits) ? apiData.hits : [];
        }

        const hits = folderCache[searchQuery];
        if (hits.length > 0) {
          for (const h of hits) {
            const q = extractQuality(h.file_name) || link.quality;
            options.push({
              label: `${q}p [${h.size}]`,
              url: h.url,
              quality: q,
              mode: "single",
              size_gb: extractSizeGb(`[${h.size}]`),
              season: link.season
            });
          }
          continue;
        }
      } catch (e) {}
    }
    options.push(link);
  }

  const uniqueOptions = [];
  const seenUrls = new Set();
  for (const opt of options) {
    if (!seenUrls.has(opt.url)) {
      seenUrls.add(opt.url);
      uniqueOptions.push(opt);
    }
  }

  return cacheSet(key, { title, url, options: uniqueOptions });
}

// ───────────────────────── Resolve ─────────────────────────
async function mdResolve(startUrl) {
  const key = `hc:${startUrl}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let targetUrl = startUrl;

  if (startUrl.includes("mdrive.lol")) {
    const { data: rawMd, request: reqMd } = await http.get(startUrl);
    const docMd = unescapeHtml(rawMd);
    const hcMatch = docMd.match(/<a[^>]+href="(https?:\/\/[^"]*hubcloud[^"]*)"[^>]*>/i) ||
                    docMd.match(/var\s+url\s*=\s*['"](https?:\/\/gamerxyt[^'"]+)['"]/i);
    if (!hcMatch) return cacheSet(key, { error: "no hubcloud link", direct_links: [], android_intent: "" });
    targetUrl = hcMatch[1].replace(/\\\//g, "/");
  }

  if (targetUrl.includes("search-recover.php")) {
    const urlObj = new URL(targetUrl);
    const b64q = urlObj.searchParams.get("q");
    let searchQuery = "";
    if (b64q) searchQuery = Buffer.from(b64q, 'base64').toString('utf-8');
    const apiUrl = targetUrl.replace(/\/drive\/search-recover\.php.*/, "/drive/search-recover.php");
    const fromAc = urlObj.searchParams.get("from_ac") || "";
    const { data: apiData } = await http.get(apiUrl, {
      params: { api: 'search', q: searchQuery, page: 1, from_ac: fromAc }
    });
    if (apiData && apiData.hits && apiData.hits.length > 0) {
      targetUrl = apiData.hits[0].url;
    } else {
      return cacheSet(key, { error: "no files found in folder", direct_links: [], android_intent: "" });
    }
  }

  const { data: raw2, request: req2 } = await http.get(targetUrl);
  const finalHubUrl = req2.res.responseUrl || targetUrl;
  const doc2 = unescapeHtml(raw2);

  let genUrl = (doc2.match(/var\s+url\s*=\s*['"](https?:\/\/[^'"]+)['"]/) || [])[1] || null;
  
  if (!genUrl) {
    const $ = cheerio.load(doc2);
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().toLowerCase();
      if (href && (href.includes('hubcloud.php') || text.includes('generate direct'))) {
        genUrl = href;
      }
    });
  }
  
  if (!genUrl) return cacheSet(key, { error: "no generator url", direct_links: [], android_intent: "" });
  
  genUrl = genUrl.replace(/\\\//g, "/");
  return await finishGenerator(genUrl, key);
}

async function finishGenerator(genUrl, key) {
  const { data: raw3, request: req3 } = await http.get(genUrl);
  const doc3 = unescapeHtml(raw3);
  
  let pxlUrl = null;
  const pxlMatch = doc3.match(/var\s+pxl\s*=\s*"([^"]+)"/) || doc3.match(/https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+/);
  if (pxlMatch) pxlUrl = pxlMatch[1] || pxlMatch[0];

  const fname = (doc3.match(/<div class="card-header[^"]*">\s*([^<]+?)\s*<\/div>/) || [])[1] || null;

  let fslUrl = null;
  const r2Match = doc3.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/hub2?\/[^\s"'<>]+/i);
  if (r2Match) fslUrl = r2Match[0];

  let gdriveUrl = null;
  
  const pixelMatch = doc3.match(/href="(https:\/\/pixel\.hubcloud\.ist\/\?id=[^"]+)"/);
  if (pixelMatch) {
      const pixelUrl = pixelMatch[1];
      const { data: raw4, request: req4 } = await http.get(pixelUrl);
      const finalPixelUrl = req4.res.responseUrl || pixelUrl;
      const doc4 = unescapeHtml(raw4);
      
      if (finalPixelUrl.includes("dl.php?link=")) {
        try {
          const urlObj = new URL(finalPixelUrl);
          gdriveUrl = urlObj.searchParams.get("link");
        } catch (e) {}
      }
      
      if (!gdriveUrl) {
          // Aggressive extraction for cryptonewz/bgmi page
          const dlMatch = doc4.match(/(https:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>\\]+)/i) || 
                          doc4.match(/var\s+link\s*=\s*['"]([^'"]+)['"]/) ||
                          doc4.match(/href\s*=\s*['"](https:\/\/video-downloads[^'"]+)['"]/);
          if (dlMatch) gdriveUrl = dlMatch[1];
      }
  }

  let android = "";
  if (gdriveUrl) {
      const host = gdriveUrl.replace(/^https?:\/\//, "");
      const fallback = encodeURIComponent(gdriveUrl);
      android = `intent://${host}#Intent;scheme=https;action=android.intent.action.VIEW;type=video/x-matroska;S.browser_fallback_url=${fallback};end`;
  }

  const direct = [];
  if (gdriveUrl) direct.push({ type: "10gbps_gdrive", url: gdriveUrl });
  if (fslUrl) direct.push({ type: "fsl_r2", url: fslUrl });
  if (pxlUrl) direct.push({ type: "pixeldrain", url: pxlUrl });

  return cacheSet(key, { file_name: fname, direct_links: direct, android_intent: android });
}

// ───────────────────────── Express App ─────────────────────────
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, version: "11.0.0" }));

app.get("/search", async (req, res) => {
  try {
    const { title, type, year, season, quality } = req.query;
    if (!title) return res.status(400).json({ error: "title required" });
    if (!type || !["movie", "series"].includes(type)) return res.status(400).json({ error: "type must be 'movie' or 'series'" });

    const isSeries = type === "series";
    const searchQ = year ? `${title} ${year}` : title;
    const searchRes = await mdSearch(searchQ);

    if (!searchRes.results.length) return res.status(404).json({ error: `no results for '${searchQ}'` });

    const matched = searchRes.results.filter((r) => {
      const t = r.title || "";
      if (year && !t.includes(String(year))) return false;
      if (season) {
        const m = t.match(/season\s*(\d+(?:\s*[–-]\s*\d+)?)/i);
        if (!m) return false;
        const raw = m[1];
        const rng = raw.match(/(\d+)\s*[–-]\s*(\d+)/);
        let ok = false;
        if (rng) {
          const lo = parseInt(rng[1], 10); const hi = parseInt(rng[2], 10);
          const s = parseInt(season, 10);
          ok = s >= lo && s <= hi;
        } else {
          ok = raw.trim() === String(season);
        }
        if (!ok) return false;
      }
      return true;
    });
    const posts = matched.length ? matched : searchRes.results;

    const results = [];
    for (const p of posts.slice(0, 5)) {
      try {
        const post = await mdPostLinks(p.permalink);
        let options = post.options;

        if (isSeries) {
          options = options.filter((o) => o.mode === "zip");
          if (season) {
            const withSeason = options.filter((o) => o.season === String(season));
            if (withSeason.length) options = withSeason;
          }
        } else {
          options = options.filter((o) => o.mode === "single");
        }

        if (quality) options = options.filter((o) => o.quality === String(quality));
        if (!options.length) continue;

        options.sort((a, b) => (b.size_gb || 0) - (a.size_gb || 0));

        results.push({ title: post.title, permalink: post.url, type, options });
      } catch (e) { continue; }
    }

    if (!results.length) return res.status(404).json({ error: `no ${type} downloads found` });
    res.json({ query: { title, type, year, season, quality }, found: results.length, results });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/download", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "url required" });
    const resolved = await mdResolve(url);
    if (resolved.error && !resolved.direct_links?.length) return res.status(502).json({ error: resolved.error });
    res.json({ source_url: url, file_name: resolved.file_name, direct_links: resolved.direct_links || [], android_intent: resolved.android_intent || "" });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`[moviesdrive-api] listening on :${PORT}`));
