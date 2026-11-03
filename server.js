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

function extractAnchorById(doc, id) {
  let m = doc.match(new RegExp(`<a\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*\\bhref\\s*=\\s*["']([^"']+)["']`, "i"));
  if (m) return m[1];
  m = doc.match(new RegExp(`<a\\b[^>]*\\bhref\\s*=\\s*["']([^"']+)["'][^>]*\\bid\\s*=\\s*["']${id}["']`, "i"));
  return m ? m[1] : null;
}

function extractR2Url(doc) {
  const m = doc.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/hub2?\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

function extractPixeldrain(doc) {
  let m = doc.match(/var\s+pxl\s*=\s*"([^"]+)"/);
  if (m) return m[1];
  m = doc.match(/https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

function extractFilename(doc) {
  let m = doc.match(/<div class="card-header[^"]*">\s*([^<]+?)\s*<\/div>/);
  if (m) return m[1].trim();
  m = doc.match(/filename%3D%22([^%"]+)%22/);
  return m ? m[1] : null;
}

function buildAndroidIntent(r2Url, mime = "application/x-z") {
  if (!r2Url) return "";
  const host = r2Url.replace(/^https?:\/\//, "");
  const fallback = encodeURIComponent(r2Url);
  return `intent://${host}#Intent;scheme=https;action=android.intent.action.VIEW;type=${mime};S.browser_fallback_url=${fallback};end`;
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

  const { data } = await http.get(TYPESENSE, { params: { q, page } });
  const hits = (data.hits || []).map((h) => {
    const d = h.document || {};
    return {
      title: d.post_title,
      permalink: new URL(d.permalink || "", BASE).toString(),
      id: d.id,
      imdb_id: d.imdb_id,
      date: d.post_date,
      categories: d.category || [],
    };
  });
  return cacheSet(key, { found: data.found || 0, results: hits });
}

// ───────────────────────── Post Scrape (Context-Aware) ─────────────────────────
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

  const options = [];
  
  // Scan the body sequentially to inherit context (Season & Quality from headers)
  let currentSeason = null;
  let currentQuality = null;

  $("body").find("h1, h2, h3, h4, h5, h6, p, div, a").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;

    // 1. Check if this element is a header that gives us new context
    if (tag !== "a") {
      // Look for Season number
      const seasonMatch = text.match(/Season\s+(\d+)/i);
      if (seasonMatch) currentSeason = seasonMatch[1];

      // Look for Quality
      const qMatch = extractQuality(text);
      if (qMatch) currentQuality = qMatch;
      
      return; // headers aren't links, skip to next
    }

    // 2. If it's an anchor, process the link
    const href = $(el).attr("href");
    if (!href || !href.startsWith("http")) return;
    if (!href.includes("mdrive.lol") && !href.includes("hubcloud")) return;
    
    const lower = text.toLowerCase();
    
    // Check if it's a download button (Zip or Episode)
    if (!lower.includes("zip") && !lower.includes("episode") && !lower.match(/\d{3,4}p/)) {
      return;
    }

    // For buttons that say just "Zip [x GB]", inherit currentSeason & currentQuality
    // For buttons that say "1080p Zip", override quality
    const btnQuality = extractQuality(text) || currentQuality;
    
    options.push({
      label: text,
      url: href,
      quality: btnQuality,
      mode: lower.includes("zip") ? "zip" : "single",
      size_gb: extractSizeGb(text),
      season: currentSeason, // <-- Attached from the header above it!
    });
  });

  return cacheSet(key, { title, url, options });
}

// ───────────────────────── Resolve ─────────────────────────
async function mdResolve(startUrl) {
  const key = `hc:${startUrl}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const steps = [];
  let hubcloudUrl = startUrl;

  if (startUrl.includes("mdrive.lol")) {
    const { data: rawMd, request: reqMd } = await http.get(startUrl);
    steps.push({ step: "mdrive", url: reqMd.res.responseUrl || startUrl });
    const docMd = unescapeHtml(rawMd);

    const hcMatch = docMd.match(/<a[^>]+href="(https?:\/\/[^"]*hubcloud[^"]*)"[^>]*>/i) ||
                    docMd.match(/var\s+url\s*=\s*['"](https?:\/\/gamerxyt[^'"]+)['"]/i);

    if (!hcMatch) return cacheSet(key, { steps, error: "no hubcloud link", direct_links: [], android_intent: "" });
    hubcloudUrl = hcMatch[1].replace(/\\\//g, "/");
    if (hubcloudUrl.includes("gamerxyt")) return await finishGenerator(hubcloudUrl, steps, key);
  } else if (!startUrl.includes("hubcloud")) {
    return cacheSet(key, { steps, error: "invalid url", direct_links: [], android_intent: "" });
  }

  steps.push({ step: "hubcloud_link", url: hubcloudUrl });

  const { data: raw2, request: req2 } = await http.get(hubcloudUrl);
  steps.push({ step: "hubcloud_page", url: req2.res.responseUrl || hubcloudUrl });
  const doc2 = unescapeHtml(raw2);

  let genUrl = (doc2.match(/var\s+url\s*=\s*['"](https?:\/\/[^'"]+)['"]/) || [])[1] || null;
  if (!genUrl) genUrl = extractAnchorById(doc2, "download");
  if (!genUrl) return cacheSet(key, { steps, error: "no generator url", direct_links: [], android_intent: "" });
  
  genUrl = genUrl.replace(/\\\//g, "/");
  steps.push({ step: "generator", url: genUrl });

  return await finishGenerator(genUrl, steps, key);
}

async function finishGenerator(genUrl, steps, key) {
  const { data: raw3, request: req3 } = await http.get(genUrl);
  steps.push({ step: "gamerxyt", url: req3.res.responseUrl || genUrl });
  const doc3 = unescapeHtml(raw3);

  const fslUrl = extractAnchorById(doc3, "fsl") || extractR2Url(doc3);
  const pxlUrl = extractPixeldrain(doc3);
  const fname = extractFilename(doc3);
  const android = fslUrl ? buildAndroidIntent(fslUrl) : "";

  const direct = [];
  if (fslUrl) direct.push({ type: "fsl_r2", url: fslUrl });
  if (pxlUrl) direct.push({ type: "pixeldrain", url: pxlUrl });

  return cacheSet(key, { steps, file_name: fname, direct_links: direct, android_intent: android });
}

// ───────────────────────── Picking ─────────────────────────
const SEASON_RE = /season\s*(\d+(?:\s*[–-]\s*\d+)?)/i;

function yearMatch(title, year) {
  if (!year) return true;
  return title.includes(String(year));
}

function seasonInPostTitle(title, season) {
  if (!season) return true;
  const m = title.match(SEASON_RE);
  if (!m) return false;
  const raw = m[1];
  const rng = raw.match(/(\d+)\s*[–-]\s*(\d+)/);
  if (rng) {
    const lo = parseInt(rng[1], 10); const hi = parseInt(rng[2], 10);
    const s = parseInt(season, 10);
    return s >= lo && s <= hi;
  }
  return raw.trim() === String(season);
}

// ───────────────────────── Express App ─────────────────────────
const app = express();

app.get("/health", (_req, res) => res.json({ ok: true, version: "5.0.0" }));

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
      if (!yearMatch(t, year)) return false;
      if (season && !seasonInPostTitle(t, season)) return false;
      return true;
    });
    const posts = matched.length ? matched : searchRes.results;

    const results = [];
    for (const p of posts.slice(0, 5)) {
      try {
        const post = await mdPostLinks(p.permalink);
        let options = post.options;

        if (isSeries) {
          // Series: zip only
          options = options.filter((o) => o.mode === "zip");
          if (season) {
            // Filter strictly by the inherited season tag
            const withSeason = options.filter((o) => o.season === String(season));
            if (withSeason.length) options = withSeason;
          }
        } else {
          // Movie: ANY link works (if it has no zip, we want single)
          options = options.filter((o) => o.mode === "single");
        }

        if (quality) options = options.filter((o) => o.quality === String(quality));

        if (!options.length) continue;

        // Deduplicate by URL (since sequential scan might catch nested things)
        const uniqueOptions = [];
        const seenUrls = new Set();
        for (const opt of options) {
           if (!seenUrls.has(opt.url)) {
               seenUrls.add(opt.url);
               uniqueOptions.push(opt);
           }
        }

        // Sort biggest first
        uniqueOptions.sort((a, b) => (b.size_gb || 0) - (a.size_gb || 0));

        results.push({
          title: post.title,
          permalink: post.url,
          type,
          options: uniqueOptions,
        });
      } catch (e) {
        continue;
      }
    }

    if (!results.length) return res.status(404).json({ error: `no ${type} downloads found${quality ? ` at ${quality}p` : ""}` });

    res.json({ query: { title, type, year, season, quality }, found: results.length, results });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/download", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "url required" });
    if (!url.includes("mdrive.lol") && !url.includes("hubcloud")) return res.status(400).json({ error: "invalid url" });

    const resolved = await mdResolve(url);
    if (resolved.error && !resolved.direct_links?.length) return res.status(502).json({ error: resolved.error, steps: resolved.steps || [] });

    res.json({
      source_url: url,
      file_name: resolved.file_name,
      direct_links: resolved.direct_links || [],
      android_intent: resolved.android_intent || "",
      steps: resolved.steps || [],
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`[moviesdrive-api] listening on :${PORT}`));
