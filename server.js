import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

// Allow your site to fetch from this API
app.use(cors());

const START_URL = "https://mp4indir.mobi";
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";

async function fetchWithDomain(path, opts = {}) {
  const headers = { "User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8", ...opts.headers };
  let body;
  if (opts.data) {
    body = new URLSearchParams(opts.data).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  
  try {
    let baseUrl = START_URL;
    if (!path.startsWith("http")) {
      const baseResp = await fetch(START_URL, { headers, signal: ctrl.signal, redirect: "follow" });
      const finalUrl = new URL(baseResp.url);
      baseUrl = `${finalUrl.protocol}//${finalUrl.host}`;
    } else {
      baseUrl = ""; 
    }

    const targetUrl = path.startsWith("http") ? path : baseUrl + path;
    const resp = await fetch(targetUrl, { method: opts.method || "GET", headers, body, signal: ctrl.signal, redirect: "follow" });
    const text = await resp.text();
    return { text, status: resp.status, final: resp.url, baseUrl };
  } finally {
    clearTimeout(t);
  }
}

// Clean the title for the file name
function cleanFileName(title, quality, episode) {
  let parts = title.split(" ");
  let shortTitle = parts.slice(0, 4).join(" ");
  shortTitle = shortTitle.replace(/[^\w\s\-]/gi, "").trim().replace(/\s+/g, "_");
  
  let epStr = "";
  if (episode && episode !== "file") {
    const epMatch = episode.match(/Episodes?:\s*(\d+)/i) || episode.match(/(\d+)/);
    if (epMatch) epStr = `_E${epMatch[1]}`;
    else epStr = `_${episode.replace(/[^\w]/g, "")}`;
  }
  return `${shortTitle}_${quality}${epStr}.mkv`;
}

async function search(query) {
  const data = { do: "search", subaction: "search", story: query };
  const { text, status, baseUrl } = await fetchWithDomain("/", { method: "POST", data, headers: { Referer: START_URL + "/" } });
  if (status !== 200) throw new Error(`search status ${status}`);
  
  const items = [];
  const re = /<li>\s*<a\s+href="(https?:\/\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi;
  let m;
  while ((m = re.exec(text))) {
    const url = m[1], block = m[2];
    const tm = block.match(/<p>\s*([\s\S]*?)\s*(?:<font|<\/p>)/i);
    const title = tm ? tm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "?";
    if (title && !items.find((x) => x.url === url)) items.push({ title, url });
  }
  return { results: items, baseUrl };
}

async function getQualities(pageUrl) {
  const { text, status } = await fetchWithDomain(pageUrl);
  if (status !== 200) throw new Error(`page status ${status}`);
  const out = [];
  const re = /<a[^>]+class="btn"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text))) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!href.includes("nexdrive")) continue;
    const q = label.match(/(\d{3,4}p)/i);
    const s = label.match(/\[(\d+(?:\.\d+)?\s*(?:MB|GB))\]/i);
    out.push({ quality: q ? q[1] : "??", size: s ? s[1].replace(/\s+/g, "") : "?", label, nexdrive: href });
  }
  return out;
}

async function getEpisodes(nexdriveUrl, baseUrl) {
  const { text, status } = await fetchWithDomain(nexdriveUrl, { headers: { Referer: baseUrl + "/" } });
  if (status !== 200) throw new Error(`nexdrive status ${status}`);
  
  const collect = (block) => {
    const links = [];
    const re = /<a[^>]+class="download ([^"]*)"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(block))) {
      const href = m[2];
      const label = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      let kind;
      if (href.includes("fast-dl.one")) kind = "gdirect";
      else if (href.includes("vgmlinks")) kind = "vcloud";
      else continue;
      links.push({ kind, url: href, label });
    }
    return links;
  };

  const eps = [];
  const secRe = /<section class="episode">([\s\S]*?)<\/section>/gi;
  let s;
  while ((s = secRe.exec(text))) {
    const block = s[1];
    const em = block.match(/class="ep-title"[^>]*>([\s\S]*?)<\/h2>/i);
    const ep = em ? em[1].replace(/<[^>]+>/g, "").trim() : "?";
    const links = collect(block);
    if (links.length) eps.push({ episode: ep, links });
  }
  if (!eps.length) {
    const loose = collect(text);
    if (loose.length) eps.push({ episode: "file", links: loose });
  }
  return eps;
}

async function resolveFastDl(fastUrl) {
  const { text, final } = await fetchWithDomain(fastUrl, { headers: { Referer: "https://nexdrive.pics/" } });
  const m = text.match(/<a[^>]+id="download-button"[^>]+href="([^"]+)"/i);
  if (!m) throw new Error("no #download-button");
  const href = m[1];
  const baseDir = final.replace(/\/[^/]*$/, "/");
  const dlUrl = new URL(href, baseDir).toString();
  
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const cfs = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const prep = `${dlUrl}${dlUrl.includes("?") ? "&" : "?"}prepare=1&hash=${hash}&cfs=${cfs}`;
  
  const { text: jt } = await fetchWithDomain(prep, {
    headers: { Referer: fastUrl, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
  });
  let data;
  try { data = JSON.parse(jt); } catch { throw new Error("non-json"); }
  if (data.ok && data.url) return data.url;
  throw new Error(data.error || "no url");
}

// ── ENDPOINT FOR YOUR SITE ─────────────────────────────────────────────────
// Usage: GET /api?title=Reacher&type=movie
// Usage: GET /api?title=Reacher&type=series
app.get("/api", async (req, res) => {
  const title = req.query.title;
  const type = req.query.type || "movie"; // 'movie' or 'series'

  if (!title) {
    return res.status(400).json({ error: "Provide ?title=Movie Name" });
  }

  try {
    // 1. Search for the title
    const { results, baseUrl } = await search(title);
    if (!results.length) {
      return res.status(404).json({ error: "No results found for this title." });
    }

    // 2. Grab the first result (usually the most accurate)
    const pageUrl = results[0].url;
    
    // 3. Get qualities
    const qs = await getQualities(pageUrl);
    if (!qs.length) {
      return res.status(404).json({ error: "No download qualities found for this title." });
    }

    // 4. Get episodes/links
    let jobs = [];
    for (const qual of qs) {
      let eps = await getEpisodes(qual.nexdrive, new URL(pageUrl).origin);
      
      // If looking for movie, only get the single file (ignore episodes)
      if (type === "movie") {
        eps = eps.filter(e => e.episode === "file" || e.links.length === 1);
      }

      for (const ep of eps) {
        for (const ln of ep.links) {
          if (ln.kind !== "gdirect") continue; // Only direct links
          try {
            const direct = await resolveFastDl(ln.url);
            jobs.push({
              quality: qual.quality,
              size: qual.size,
              episode: ep.episode,
              direct_url: direct,
              file_name: cleanFileName(title, qual.quality, ep.episode)
            });
          } catch (e) {
            // Skip failed links to keep the UI clean
          }
        }
      }
    }

    if (!jobs.length) {
      return res.status(404).json({ error: "No direct links could be resolved." });
    }

    // 5. Return JSON for your site
    res.json({
      success: true,
      title: results[0].title,
      page_url: pageUrl,
      type: type,
      downloads: jobs
    });

  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.listen(PORT, () => {
  console.log(`Mp4Mania API running on port ${PORT}`);
});
