import express from "express";
import fetch, { Headers } from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 静态页（生成器/播放器）
app.use(express.static("public"));

// 基础 CORS
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  });
  if (/%20+$/.test(req.url)) req.url = req.url.replace(/%20+$/g, ""); // 去掉尾部空格
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 根路由直接返回主页（可改成 index.html）
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const UA_DEFAULT = "okHttp/Mod-1.1.0";
const UA_MAP = {
  "sub.ottiptv.cc": UA_DEFAULT,
  "mursor.ottiptv.cc": UA_DEFAULT,
};

// 工具
const toAbs = (child, base) => { try { return new URL(child, base).toString(); } catch { return child; } };
const mustM3U8 = (ct, url) => /(vnd\.apple\.mpegurl|x-mpegurl)/i.test(ct || "") || /\.m3u8(\?|$)/i.test(url);
const decodeOnce = v => { try { return /%25[0-9A-Fa-f]{2}/.test(v) ? decodeURIComponent(v) : v; } catch { return v; } };

const makeGW = (origin, absUrl, qs, keepSuffix = true) => {
  const u = new URL(keepSuffix ? "/proxy.m3u8" : "/proxy", origin);
  u.searchParams.set("u", absUrl);
  for (const k of ["ua","ref","origin","cookie","xff","xip"]) {
    if (qs[k]) u.searchParams.set(k, qs[k]);
  }
  // 任意自定义头（以 h_ 前缀传入）
  Object.entries(qs).forEach(([k,v])=>{
    if (k.startsWith("h_") && v) u.searchParams.set(k, v);
  });
  return u.toString();
};

function buildHeaders(req, targetUrl, qs) {
  const h = new Headers();
  // 常见默认头
  h.set("Accept", "*/*");
  h.set("Connection", "keep-alive");
  h.set("Accept-Language", qs["h_accept-language"] || "zh-CN,zh;q=0.9,en;q=0.8");
  // Range 透传
  const range = req.headers["range"];
  if (range) h.set("Range", range);
  // UA / Ref / Origin
  const ua = qs.ua || "";
  const ref = qs.ref || "";
  const ori = qs.origin || "";
  if (ua) h.set("User-Agent", ua);
  if (ref) h.set("Referer", ref);
  if (ori) h.set("Origin", ori);
  // Cookie（可选）
  if (qs.cookie) h.set("Cookie", qs.cookie);
  // IP 相关（可选）
  if (qs.xff) h.set("X-Forwarded-For", qs.xff);
  if (qs.xip) h.set("X-Real-IP", qs.xip);

  // 任意头（h_前缀）
  Object.entries(qs).forEach(([k,v])=>{
    if (k.startsWith("h_") && v) {
      const name = k.slice(2).replace(/_/g, "-"); // h_accept_language -> accept-language
      h.set(name, v);
    }
  });

  try {
    const host = new URL(targetUrl).host.toLowerCase();
    if (!ua && UA_MAP[host]) h.set("User-Agent", UA_MAP[host]);
  } catch {}
  return h;
}

// 强制重写：任何非 # 行都改为继续走代理；KEY/MAP 的 URI 也改
async function rewriteM3U8(text, baseUrl, self, qs) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    if (/^#EXT-X-KEY:/i.test(line) && /URI="/i.test(line)) {
      line = line.replace(/URI="([^"]+)"/i, (_m, p1) => `URI="${makeGW(self, toAbs(p1, baseUrl), qs, false)}"`);
      out.push(line); continue;
    }
    if (/^#EXT-X-MAP:/i.test(line) && /URI="/i.test(line)) {
      line = line.replace(/URI="([^"]+)"/i, (_m, p1) => `URI="${makeGW(self, toAbs(p1, baseUrl), qs, false)}"`);
      out.push(line); continue;
    }
    if (line.trim() && !line.startsWith("#")) {
      out.push(makeGW(self, toAbs(line.trim(), baseUrl), qs, true)); continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// 单频道订阅
app.get("/single.m3u", (req, res) => {
  const { u, name = "Channel", ...qs } = req.query;
  if (!u) return res.status(400).type("application/x-mpegurl").send("# missing param: u\n");
  const target = decodeOnce(u);
  const play = makeGW(`${req.protocol}://${req.get("host")}`, target, qs);
  res.status(200).set({
    "Content-Type": "application/x-mpegurl; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename="${encodeURIComponent(name)}.m3u"`
  }).send(`#EXTM3U
#EXTINF:-1,${name}
${play}
`);
});

// 代理
app.get(["/proxy", "/proxy.m3u8"], async (req, res) => {
  const { u, ...qs } = req.query;
  if (!u) return res.status(400).send("missing param: u");
  const target = decodeOnce(u);
  try {
    const fh = buildHeaders(req, target, qs);
    const upstream = await fetch(target, { method: "GET", headers: fh, redirect: "follow" });
    const ct = upstream.headers.get("content-type") || "";
    if (mustM3U8(ct, target)) {
      const text = await upstream.text();
      const base = new URL(target);
      const self = `${req.protocol}://${req.get("host")}`;
      const rewritten = await rewriteM3U8(text, base, self, qs);
      return res.status(200).set({
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control": "no-store"
      }).send(rewritten);
    }
    // 二进制透传
    res.status(upstream.status);
    res.set("Cache-Control", "no-store");
    if (ct) res.type(ct);
    ["content-length","accept-ranges","content-range"].forEach(k=>{
      const v = upstream.headers.get(k); if (v) res.set(k, v);
    });
    upstream.body.pipe(res);
  } catch (e) {
    console.error("proxy error:", e);
    res.status(502).send("Bad Gateway: " + (e?.message || String(e)));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("m3u-proxy listening on port", PORT));
