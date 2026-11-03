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

// ───────────────────────── search ─────────────────────────
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

// ───────────────────────── post scrape ─────────────────────────
// Buckets:
//   hubcloud  → anything that is a per-quality download link (mdrive.lol OR hubcloud.ist)
//   gdflix    → gdflix.vip links
//   other     → any other external
// We bucket by LABEL first (quality/mode), then by href host if label isn't clear.
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
  const groups = { hubcloud: [], gdflix: [], other: [] };

  // "720p Single Episode", "1080p Zip [10.6GB]", "4K 2160p Single Episode", etc.
  const dlLabelRe = /(\d{3,4}p|4k|2160p).*(single|zip|episode)/i;

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || !label || !href.startsWith("http")) return;

    const entry = { label, url: href };

    if (href.includes("gdflix")) {
      groups.gdflix.push(entry);
      return;
    }
    if (dlLabelRe.test(label)) {
      groups.hubcloud.push(entry);
      return;
    }
    if (href.includes("hubcloud") || href.includes("mdrive.lol")) {
      groups.hubcloud.push(entry);
      return;
    }
    groups.other.push(entry);
  });

  return cacheSet(key, { title, url, links: groups });
}

// ───────────────────────── resolver (mdrive → hubcloud → gamerxyt) ─────────────────────────
async function mdResolve(startUrl) {
  const key = `hc:${startUrl}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const steps = [];
  let hubcloudUrl = startUrl;

  // Hop 1 — mdrive.lol/archive/<id>  →  find hubcloud.ist link inside
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

    // If mdrive gave us a gamerxyt URL directly, skip hubcloud page hop
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

  // Hop 2 — hubcloud share page → find generator url
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

// ───────────────────────── smart picking ─────────────────────────
const QUALITY_RE = /\b(480p|720p|1080p|2160p|4K)\b/i;
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

function pickHubcloud(links, quality, mode, season, episode) {
  if (!links.length) return null;

  function score(ln) {
    const label = ln.label.toLowerCase();
    let s = 0;

    if (quality) {
      const q = quality.toLowerCase().replace("p", "").replace("4k", "2160");
      const labelQs = (label.match(QUALITY_RE) || []).map((x) =>
        x.toLowerCase().replace("p", "").replace("4k", "2160")
      );
      if (labelQs.includes(q)) s += 10;
      else if (labelQs.some((x) => x === "1080" || x === "2160")) s += 3;
    }

    const isZip = label.includes("zip");
    if (mode === "zip" && isZip) s += 20;
    else if (mode === "single" && !isZip) s += 20;

    if (season && label.includes(`season ${season}`)) s += 5;
    if (episode) {
      const ep = String(parseInt(episode, 10)).padStart(2, "0");
      if (label.includes(`ep${ep}`) || label.includes(`episode ${ep}`)) s += 5;
    }
    return s;
  }

  return [...links].sort((a, b) => score(b) - score(a))[0];
}

// ───────────────────────── express app ─────────────────────────
const app = express();

app.get("/health", (_req, res) => res.json({ ok: true, version: "3.1.0" }));

app.get("/search", async (req, res) => {
  try {
    const { q, year, page } = req.query;
    if (!q) return res.status(400).json({ error: "q required" });
    const out = await mdSearch(q, parseInt(page || "1", 10));
    if (year) {
      const filtered = out.results.filter((r) => yearMatch(r.title || "", year));
      if (filtered.length) out.results = filtered;
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

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
    if (!url.includes("hubcloud") && !url.includes("mdrive.lol")) {
      return res
        .status(400)
        .json({ error: "url must contain hubcloud or mdrive.lol" });
    }
    res.json(await mdResolve(url));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/download", async (req, res) => {
  try {
    const { title, year, season, episode, quality, mode = "single" } = req.query;

    if (!title) return res.status(400).json({ error: "title required" });
    if (mode !== "single" && mode !== "zip") {
      return res.status(400).json({ error: "mode must be single or zip" });
    }

    const q = year ? `${title} ${year}` : title;
    const searchRes = await mdSearch(q);
    if (!searchRes.results.length) {
      return res.status(404).json({ error: `no results for '${q}'` });
    }

    const postHit = pickPost(searchRes.results, year, season);
    if (!postHit) return res.status(404).json({ error: "no post matched filters" });

    const post = await mdPostLinks(postHit.permalink);
    const hubcloud = post.links.hubcloud;
    if (!hubcloud.length) {
      return res.status(404).json({
        error: "no hubcloud links",
        post: { title: post.title, url: post.url },
        gdflix: post.links.gdflix,
        all_labels_seen: post.links.other.map((o) => o.label),
      });
    }

    const chosen = pickHubcloud(hubcloud, quality, mode, season, episode);
    if (!chosen) return res.status(404).json({ error: "no link matched" });

    const resolved = await mdResolve(chosen.url);

    res.json({
      query: { title, year, season, episode, quality, mode },
      post: { title: post.title, url: post.url },
      chosen_link: chosen,
      file_name: resolved.file_name,
      direct_links: resolved.direct_links || [],
      android_intent: resolved.android_intent || "",
      all_hubcloud_labels: hubcloud.map((ln) => ln.label),
      steps: resolved.steps || [],
      error: resolved.error || null,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`[moviesdrive-api] listening on :${PORT}`);
});
