import express from "express";
import fetch from "node-fetch";

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://vidvault.to";

const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36";

const VV_HEADERS = {
  "User-Agent"     : UA,
  "Accept"         : "application/json, */*",
  "Referer"        : BASE + "/",
  "Origin"         : BASE,
  "sec-fetch-site" : "same-origin",
  "sec-fetch-mode" : "cors",
  "sec-fetch-dest" : "empty",
};

const QUALITIES = ["1080p", "720p", "480p", "360p"];

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  process.env.ALLOW_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── optional API key guard ─────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!process.env.API_KEY) return next();
  if (req.path === "/health") return next();
  const key = req.headers["x-api-key"] ||
              (req.headers["authorization"] || "").replace("Bearer ", "");
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
});

// ── helper ────────────────────────────────────────────────────────────────────
const fetchOne = async (type, id, season, episode, q) => {
  try {
    let url = `${BASE}/download-link/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
    if (type === "tv" && season && episode) {
      url += `/${encodeURIComponent(season)}/${encodeURIComponent(episode)}`;
    }
    url += `/${encodeURIComponent(q)}`;

    const r    = await fetch(url, { headers: VV_HEADERS, timeout: 25000 });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) return null;

    const raw   = String(data.url);
    const clean = raw.split("?")[0].split("#")[0];
    return {
      quality : q,
      url     : clean.endsWith(".mkv") ? clean : clean + ".mkv",
    };
  } catch {
    return null;
  }
};

// ── GET /links ─────────────────────────────────────────────────────────────────
// ?type=movie&id=969681
// ?type=tv&id=108978&season=1&episode=1
// ?type=movie&id=969681&quality=720p
app.get("/links", async (req, res) => {
  const { type, id, season, episode, quality } = req.query;

  if (!type || !id) {
    return res.status(400).json({ ok: false, error: "type and id are required" });
  }
  if (!["movie", "tv"].includes(type)) {
    return res.status(400).json({ ok: false, error: "type must be movie or tv" });
  }

  try {
    if (quality) {
      const r = await fetchOne(type, id, season, episode, quality);
      if (!r) return res.status(404).json({ ok: false, error: "quality not available" });
      return res.json({ ok: true, ...r });
    }

    const results = (
      await Promise.all(QUALITIES.map(q => fetchOne(type, id, season, episode, q)))
    ).filter(Boolean);

    res.json({ ok: true, count: results.length, links: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /proxy ─────────────────────────────────────────────────────────────────
// ?url=ENCODED_WORKER_URL&filename=movie.mkv
// pipes the MKV through this server so browser download works without Referer header
app.get("/proxy", async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: "url required" });

  let decoded;
  try { decoded = decodeURIComponent(url); }
  catch { return res.status(400).json({ ok: false, error: "bad url encoding" }); }

  // only proxy vidvault worker URLs — safety gate
  if (!decoded.includes("workers.dev") && !decoded.includes("vidvault.to")) {
    return res.status(403).json({ ok: false, error: "not allowed" });
  }

  try {
    const upstream = await fetch(decoded, {
      headers: {
        "User-Agent": UA,
        "Referer"   : BASE + "/",
        "Accept"    : "*/*",
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok    : false,
        error : `upstream returned ${upstream.status}`,
      });
    }

    const name = filename || "download.mkv";
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/x-matroska");

    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    upstream.body.pipe(res);

  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

// ── GET /health ────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`vidvault-api running on :${PORT}`);
});
