import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const BASE = "https://new1.moviesdrive.cyou";
const TYPESENSE = `${BASE}/search.php`;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || "900", 10) * 1000;

const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";

const MD_HEADERS = {
  "user-agent": UA,
  accept: "*/*",
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
  referer: `${BASE}/search.html`,
};

const http = axios.create({
  timeout: 25000,
  headers: MD_HEADERS,
  maxRedirects: 10,
  validateStatus: (s) => s >= 200 && s < 400,
});

// ───────────────────────── tiny cache ─────────────────────────
const CACHE = new Map();
function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL) {
    CACHE.delete(key);
    return null;
  }
  return v.v;
}
function cacheSet(key, val) {
  CACHE.set(key, { v: val, t: Date.now() });
  return val;
}

// ───────────────────────── helpers ─────────────────────────
function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function extractAnchorById(doc, id) {
  let m = doc.match(
    new RegExp(
      `<a\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*\\bhref\\s*=\\s*["']([^"']+)["']`,
      "i"
    )
  );
  if (m) return m[1];
  m = doc.match(
    new RegExp(
      `<a\\b[^>]*\\bhref\\s*=\\s*["']([^"']+)["'][^>]*\\bid\\s*=\\s*["']${id}["']`,
      "i"
    )
  );
  return m ? m[1] : null;
}

function extractR2Url(doc) {
  const m = doc.match(
    /https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/hub2?\/[^\s"'<>]+/i
  );
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
  return (
    `intent://${host}#Intent;scheme=https;` +
    `action=android.intent.action.VIEW;type=${mime};` +
    `S.browser_fallback_url=${fallback};end`
  );
}

// extract quality number from a label: "1080p Zip [10.6GB]" → "1080"
function labelQuality(label) {
  const m = label.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  if (raw === "4k") return "2160";
  return raw.replace("p", "");
}

function labelMode(label) {
  return label.toLowerCase().includes("zip") ? "zip" : "single";
}

function labelSizeGb(label) {
  const m = label.match(/\[([\d.]+)\s*(gb|mb)\]/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "gb" ? num : num / 1024;
}

// ───────────────────────── search (typesense only) ─────────────────────────
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

// ───────────────────────── post scrape (no resolve) ─────────────────────────
async function mdPostLinks(permalink) {
  const url = permalink.startsWith("http")
    ? permalink
    : new URL(permalink, BASE).toString();
  const key = `post:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const { data: raw } = await http.get(url);
  const doc = unescapeHtml(raw);

  const titleMatch = doc.match(/<h1 class="post-title">([^<]+)<\/h1>/);
  const title = titleMatch ? titleMatch[1].trim() : null;

  const $ = cheerio.load(doc);
  const dlLabelRe = /(\d{3,4}p|4k|2160p).*(single|zip|episode)/i;

  // every quality-labelled download anchor, normalized
  const options = [];
  const gdflix = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || !label || !href.startsWith("http")) return;

    if (href.includes("gdflix")) {
      gdflix.push({ label, url: href });
      return;
    }
    if (!dlLabelRe.test(label)) return;
    if (!href.includes("mdrive.lol") && !href.includes("hubcloud")) return;

    options.push({
      label,
      url: href,
      quality: labelQuality(label),
      mode: labelMode(label),
      size_gb: labelSizeGb(label),
    });
  });

  return cacheSet(key, { title, url, options, gdflix });
}

// ───────────────────────── resolve (the only place that hits the chain) ─────────────────────────
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

    const hcMatch =
      docMd.match(/<a[^>]+href="(https?:\/\/[^"]*hubcloud[^"]*)"[^>]*>/i) ||
      docMd.match(/var\s+url\s*=\s*['"](https?:\/\/gamerxyt[^'"]+)['"]/i);

    if (!hcMatch) {
      return cacheSet(key, {
        steps,
        error: "no hubcloud link on mdrive page",
        direct_links: [],
        android_intent: "",
      });
    }
    hubcloudUrl = hcMatch[1].replace(/\\\//g, "/");

    if (hubcloudUrl.includes("gamerxyt")) {
      return await finishGenerator(hubcloudUrl, steps, key);
    }
  } else if (!startUrl.includes("hubcloud")) {
    return cacheSet(key, {
      steps,
      error: "url is not mdrive or hubcloud",
      direct_links: [],
      android_intent: "",
    });
  }

  steps.push({ step: "hubcloud_link", url: hubcloudUrl });

  const { data: raw2, request: req2 } = await http.get(hubcloudUrl);
  steps.push({ step: "hubcloud_page", url: req2.res.responseUrl || hubcloudUrl });
  const doc2 = unescapeHtml(raw2);

  let genUrl =
    (doc2.match(/var\s+url\s*=\s*['"](https?:\/\/[^'"]+)['"]/) || [])[1] || null;
  if (!genUrl) genUrl = extractAnchorById(doc2, "download");
  if (!genUrl) {
    return cacheSet(key, {
      steps,
      error: "no generator url",
      direct_links: [],
      android_intent: "",
    });
  }
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

  return cacheSet(key, {
    steps,
    file_name: fname,
    direct_links: direct,
    android_intent: android,
  });
}

// ───────────────────────── picking ─────────────────────────
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
    const lo = parseInt(rng[1], 10);
    const hi = parseInt(rng[2], 10);
    const s = parseInt(season, 10);
    return s >= lo && s <= hi;
  }
  return raw.trim() === String(season);
}

function pickPost(results, year, season) {
  for (const r of results) {
    const t = r.title || "";
    if (!yearMatch(t, year)) continue;
    if (season && !seasonInPostTitle(t, season)) continue;
    return r;
  }
  return results[0] || null;
}

// For a given post's `options` array, return what the user should see.
// Series → only zip options. Movie → only single options.
function filterOptions(options, isSeries, season, quality) {
  let pool = options.filter((o) => (isSeries ? o.mode === "zip" : o.mode === "single"));

  if (quality) pool = pool.filter((o) => o.quality === String(quality));

  // if a specific season was requested, prefer labels that mention it
  if (isSeries && season) {
    const withSeason = pool.filter((o) =>
      o.label.toLowerCase().includes(`season ${season}`)
    );
    if (withSeason.length) pool = withSeason;
  }

  // biggest first (usually highest quality + most content)
  return pool.sort((a, b) => (b.size_gb || 0) - (a.size_gb || 0));
}

// ───────────────────────── express app ─────────────────────────
const app = express();

app.get("/health", (_req, res) => res.json({ ok: true, version: "4.0.0" }));

/**
 * GET /search?title=X&year=Y&season=N&quality=Q
 *
 * Returns posts with their DOWNLOAD OPTIONS (no resolving, no direct links).
 * Each option has: label, url (mdrive/hubcloud), quality, mode, size_gb.
 * Filtered by type: series → zip options only, movie → single options only.
 *
 * If multiple posts match, we return all of them, each with its own options.
 */
app.get("/search", async (req, res) => {
  try {
    const { title, q, year, season, quality } = req.query;
    const query = title || q;
    if (!query) return res.status(400).json({ error: "title (or q) required" });

    const isSeries = !!season;
    const searchQ = year ? `${query} ${year}` : query;
    const searchRes = await mdSearch(searchQ);

    if (!searchRes.results.length) {
      return res.status(404).json({ error: `no results for '${searchQ}'` });
    }

    // Keep posts whose title matches year/season constraints, but don't collapse to one.
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
        const options = filterOptions(post.options, isSeries, season, quality);
        if (!options.length) continue;
        results.push({
          title: post.title,
          permalink: post.url,
          type: isSeries ? "series" : "movie",
          options,
        });
      } catch (e) {
        // skip posts that fail to scrape; don't blow up the whole search
        continue;
      }
    }

    if (!results.length) {
      return res.status(404).json({
        error: isSeries
          ? `no whole-season zip found${quality ? ` at ${quality}p` : ""}`
          : `no single-file download found${quality ? ` at ${quality}p` : ""}`,
        searched_posts: posts.map((p) => p.permalink),
      });
    }

    res.json({
      query: { title: query, year, season, quality, type: isSeries ? "series" : "movie" },
      found: results.length,
      results,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * GET /download?url=<mdrive_or_hubcloud_url>
 *
 * Takes ONE of the option URLs from /search and resolves it
 * all the way down to the direct FSL/R2 + pixeldrain links.
 *
 * This is the ONLY endpoint that does the expensive chain.
 */
app.get("/download", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "url required" });
    if (!url.includes("mdrive.lol") && !url.includes("hubcloud")) {
      return res
        .status(400)
        .json({ error: "url must be an mdrive.lol or hubcloud link from /search" });
    }

    const resolved = await mdResolve(url);

    if (resolved.error && !resolved.direct_links?.length) {
      return res.status(502).json({
        error: resolved.error,
        steps: resolved.steps || [],
      });
    }

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

// legacy: keep /post and /resolve for debugging
app.get("/post", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url required" });
    res.json(await mdPostLinks(req.query.url));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/resolve", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "url required" });
    res.json(await mdResolve(url));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`[moviesdrive-api] listening on :${PORT}`);
});
