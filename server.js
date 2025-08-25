import express from "express";
import fetch, { Headers } from "node-fetch";

const app = express();

// 静态文件：生成器网页
app.use(express.static("public"));

// ====== CORS ======
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const UA_MAP = {
  "sub.ottiptv.cc":    "okHttp/Mod-1.1.0",
  "mursor.ottiptv.cc": "okHttp/Mod-1.1.0",
};

// 工具函数
function toAbs(child, base) { try { return new URL(child, base).toString(); } catch { return child; } }
function makeGW(origin, absUrl, qs, keepM3U8Suffix = true) {
  const u = new URL(keepM3U8Suffix ? "/proxy.m3u8" : "/proxy", origin);
  u.searchParams.set("u", absUrl);
  if (qs.ua)     u.searchParams.set("ua", qs.ua);
  if (qs.ref)    u.searchParams.set("ref", qs.ref);
  if (qs.origin) u.searchParams.set("origin", qs.origin);
  return u.toString();
}
function isM3U8(ct, urlStr) {
  const c = (ct || "").toLowerCase();
  return /application\/(vnd\.apple\.mpegurl|x-mpegurl)/.test(c) || /\.m3u8(\?|$)/i.test(urlStr);
}
function buildForwardHeaders(req, targetUrl, qs) {
  const h = new Headers();
  h.set("Accept", "*/*");
  const range = req.headers["range"];
  if (range) h.set("Range", range);
  const ua = qs.ua || "";
  const ref = qs.ref || "";
  const origin = qs.origin || "";
  if (ua) h.set("User-Agent", ua);
  if (ref) h.set("Referer", ref);
  if (origin) h.set("Origin", origin);
  try {
    const host = new URL(targetUrl).host.toLowerCase();
    if (!ua && UA_MAP[host]) h.set("User-Agent", UA_MAP[host]);
  } catch {}
  return h;
}
async function rewriteM3U8(text, baseUrl, self, qs) {
  const lines = text.split(/\r?\n/), out = [];
  for (let line of lines) {
    if (/^#EXT-X-KEY:/i.test(line) && /URI="/i.test(line)) {
      out.push(line.replace(/URI="([^"]+)"/i, (m, p1) => `URI="${makeGW(self, toAbs(p1, baseUrl), qs, false)}"`));
      continue;
    }
    if (/^#EXT-X-MAP:/i.test(line) && /URI="/i.test(line)) {
      out.push(line.replace(/URI="([^"]+)"/i, (m, p1) => `URI="${makeGW(self, toAbs(p1, baseUrl), qs, false)}"`));
      continue;
    }
    if (line.trim() && !line.startsWith("#")) {
      out.push(makeGW(self, toAbs(line.trim(), baseUrl), qs, true));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// ====== 路由 ======
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/single.m3u", (req, res) => {
  const { u, name = "Channel", ua = "", ref = "", origin = "" } = req.query;
  if (!u) return res.status(400).type("application/x-mpegurl").send("# missing param: u\n");
  const play = makeGW(`${req.protocol}://${req.get("host")}`, u, { ua, ref, origin });
  res.status(200).set({
    "Content-Type": "application/x-mpegurl; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename="${encodeURIComponent(name)}.m3u"`
  }).send(`#EXTM3U
#EXTINF:-1,${name}
${play}
`);
});

app.get(["/proxy", "/proxy.m3u8"], async (req, res) => {
  const { u: target, ua = "", ref = "", origin = "" } = req.query;
  if (!target) return res.status(400).send("missing param: u");
  try {
    const fh = buildForwardHeaders(req, target, { ua, ref, origin });
    const upstream = await fetch(target, { method: "GET", headers: fh, redirect: "follow" });
    const ct = upstream.headers.get("content-type") || "";

    if (isM3U8(ct, target)) {
      const text = await upstream.text();
      const base = new URL(target);
      const rewritten = await rewriteM3U8(text, base, `${req.protocol}://${req.get("host")}`, { ua, ref, origin });
      return res.status(200).set({
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control": "no-store"
      }).send(rewritten);
    }

    res.status(upstream.status);
    res.set("Cache-Control", "no-store");
    if (ct) res.type(ct);
    ["content-length","accept-ranges","content-range"].forEach(k=>{
      const v = upstream.headers.get(k); if (v) res.set(k, v);
    });
    upstream.body.pipe(res);
  } catch (e) {
    console.error("proxy error:", e);
    res.status(502).send("Bad Gateway: " + (e && e.message || String(e)));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("m3u-proxy listening on port", PORT);
});
