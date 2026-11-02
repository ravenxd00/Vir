import express from "express";
import cors from "cors";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const START_URL = "https://mp4indir.mobi";
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";

// 🔴 YOUR HTTPS PROXY
const PROXY_URL = "http://u_w38g3c:ucx1yx2157@proxies.toolz.ovh:8443"; 
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

// Initialize a client with a cookie jar (so it remembers PHPSESSID)
const jar = new CookieJar();
const client = wrapper(axios.create({
  httpsAgent: proxyAgent,
  httpAgent: proxyAgent,
  jar,
  timeout: 25000,
}));

let BASE_DOMAIN = START_URL;

async function fetchWithDomain(path, opts = {}) {
  const headers = { 
    "User-Agent": UA, 
    "Accept": "*/*", 
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    ...opts.headers 
  };
  let data = null;
  if (opts.data) {
    data = new URLSearchParams(opts.data).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  try {
    // 1. Resolve the live domain & get initial cookies
    if (!path.startsWith("http") && !BASE_DOMAIN) {
      const baseResp = await client.get(START_URL, { headers });
      const finalUrl = new URL(baseResp.request.res.responseUrl || START_URL);
      BASE_DOMAIN = `${finalUrl.protocol}//${finalUrl.host}`;
    }

    const targetUrl = path.startsWith("http") ? path : BASE_DOMAIN + path;
    
    // 2. Ensure Referer matches the exact domain being hit
    if (targetUrl.includes(BASE_DOMAIN)) {
        headers["Referer"] = BASE_DOMAIN + "/";
        headers["Origin"] = BASE_DOMAIN;
    }

    const resp = await client({
      method: opts.method || "GET",
      url: targetUrl,
      headers,
      data,
      maxRedirects: 5,
      validateStatus: () => true
    });
    
    if (resp.status !== 200) {
      console.log(`[!] Status ${resp.status} for ${targetUrl}`);
    }
    
    return { 
      text: typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data), 
      status: resp.status, 
      final: resp.request.res.responseUrl || targetUrl, 
      baseUrl: BASE_DOMAIN 
    };
  } catch (err) {
    console.error(`[!] Proxy Network Error: ${err.message}`);
    throw new Error(`Proxy Error: ${err.message}`);
  }
}

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
  // First hit homepage to get cookies
  await fetchWithDomain("/");

  const data = { do: "search", subaction: "search", story: query };
  const { text, status, baseUrl } = await fetchWithDomain("/", { 
      method: "POST", 
      data, 
      headers: { "Referer": BASE_DOMAIN + "/" } 
  });
  
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

app.get("/api", async (req, res) => {
  const title = req.query.title;
  const type = req.query.type || "movie";

  if (!title) {
    return res.status(400).json({ error: "Provide ?title=Movie Name" });
  }

  try {
    const { results, baseUrl } = await search(title);
    if (!results.length) {
      return res.status(404).json({ error: "No results found for this title." });
    }

    const pageUrl = results[0].url;
    const qs = await getQualities(pageUrl);
    if (!qs.length) {
      return res.status(404).json({ error: "No download qualities found for this title." });
    }

    let jobs = [];
    for (const qual of qs) {
      let eps = await getEpisodes(qual.nexdrive, new URL(pageUrl).origin);
      
      if (type === "movie") {
        eps = eps.filter(e => e.episode === "file" || e.links.length === 1);
      }

      for (const ep of eps) {
        for (const ln of ep.links) {
          if (ln.kind !== "gdirect") continue;
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
            console.log(`[!] FastDl Error: ${e.message}`);
          }
        }
      }
    }

    if (!jobs.length) {
      return res.status(404).json({ error: "No direct links could be resolved." });
    }

    res.json({
      success: true,
      title: results[0].title,
      page_url: pageUrl,
      type: type,
      downloads: jobs
    });

  } catch (e) {
    console.error(`[Server Error] ${e.message}`);
    res.status(500).json({ error: String(e.message) });
  }
});

app.listen(PORT, () => {
  console.log(`Mp4Mania API running on port ${PORT} with HTTPS Proxy`);
});
