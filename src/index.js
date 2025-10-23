// 🚀 Bandwidth Hero Cloudflare Worker v4.7
// ✅ Fix normal wsrv.nl compression (was skipping)
// ✅ Fix masked compression (double-encoded, 400-safe)
// ✅ Auto referer for Mangabuddy / Mangapill / Hentaifox / NHentai
// ✅ Caching + KV stats + debug logging

const MASK_PROXY = "https://proxy-img.zoro1.workers.dev/"; // secondary Worker (must serve raw image)

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// ========== REFERER MAP ==========
function getRefererForHost(host, url = "") {
  host = host.toLowerCase();
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) return "https://mangabuddy.com/";
  if (host.includes("mgcdn.xyz") || host.includes("mbbcdn.com")) return "https://res.mgcdn.xyz/";
  if (host.includes("readdetectiveconan.com") || host.includes("mangapill.com")) return "https://mangapill.com/";
  if (host.includes("hentaifox.com")) return "https://hentaifox.com/";
  if (host.includes("nhentai.net")) return "https://nhentai.net/";
  if (host.includes("1stkmgv1.com")) return "https://mangabuddy.com/";
  if (host.includes("mbcdns")) return "https://mangabuddy.com/";
  return `https://${host}/`;
}

// ========== ENTRY ==========
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleCORS();
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ ok: true, time: Date.now() }), { headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/stats") return await showStatsPage(env);
    if (url.pathname === "/reset") { await env.KV_STATS.delete("stats"); return new Response("✅ Stats reset."); }
    if (!url.searchParams.get("url")) return getWebInterface();

    if (url.searchParams.get("mask") === "1")
      return await serveRawImage(url.searchParams.get("url"));

    try {
      return await handleImageRequest(request, env, ctx);
    } catch (e) {
      console.error("❌ Worker error:", e);
      return errorResponse(e.message, 500);
    }
  },
};

// ========== MAIN IMAGE LOGIC ==========
async function handleImageRequest(request, env, ctx) {
  const start = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const debug = url.searchParams.get("debug") === "1";
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const bw = url.searchParams.get("bw") === "1";
  const q = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));

  const parsed = new URL(targetUrl);
  const referer = getRefererForHost(parsed.hostname, targetUrl);
  const cache = caches.default;
  const cacheKey = new Request(`${targetUrl}#q=${q}-${jpeg ? "jpg" : "webp"}-${bw ? "bw" : "color"}`);

  // Cache hit
  const cached = await cache.match(cacheKey);
  if (cached) {
    if (debug) console.log("✅ Cache HIT");
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, start, "HIT", q);
  }

  if (debug) console.log(`📥 Fetching ${parsed.hostname} | q=${q}`);

  let res = null;

  // === ATTEMPT 1: Normal wsrv.nl compression ===
  const wsrvUrl = `https://wsrv.nl/?url=${encodeURIComponent(targetUrl)}&q=${q}&output=${jpeg ? "jpg" : "webp"}${bw ? "&il" : ""}`;
  if (debug) console.log(`🌀 wsrv.nl -> ${wsrvUrl}`);

  try {
    res = await fetch(wsrvUrl, {
      headers: {
        Referer: referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("image/")) {
      if (debug) console.log(`❌ wsrv.nl failed: ${res.status}`);
      res = null;
    } else if (debug) console.log("✅ wsrv.nl success");
  } catch (e) {
    if (debug) console.log(`⚠️ wsrv.nl error: ${e.message}`);
  }

  // === ATTEMPT 2: Masked wsrv.nl (double-encoded) ===
  if (!res) {
    // 🧩 Fixed masked retry (safer encoding, uses images.weserv.nl)
const maskSrc = `${MASK_PROXY}?mask=1&url=${encodeURIComponent(targetUrl)}`;
const maskedEncoded = encodeURIComponent(
  maskSrc.replace(/\?/g, "%3F").replace(/&/g, "%26")
);
const maskedUrl = `https://images.weserv.nl/?url=${maskedEncoded}&q=${q}&output=${
  jpeg ? "jpg" : "webp"
}${bw ? "&il" : ""}`;
    if (debug) console.log(`🎭 Masked wsrv -> ${maskedUrl}`);

    try {
      const maskedRes = await fetch(maskedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
      if (maskedRes.ok && (maskedRes.headers.get("content-type") || "").includes("image/")) {
        if (debug) console.log("✅ Masked wsrv.nl success");
        res = maskedRes;
      } else if (debug) console.log(`❌ Masked wsrv failed: ${maskedRes.status}`);
    } catch (e) {
      if (debug) console.log(`⚠️ Masked wsrv error: ${e.message}`);
    }
  }

  // === ATTEMPT 3: Direct fetch ===
  if (!res) {
    if (debug) console.log("🔴 All compression failed, direct fetch...");
    res = await fetch(targetUrl, {
      headers: {
        Referer: referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
        Accept: "image/*,*/*;q=0.8",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });
  }

  // === Check result ===
  if (!res || !res.ok) {
    console.error(`❌ ALL FAILED (${res?.status || "ERR"})`);
    return errorResponse(`Failed (${res?.status || 502})`, res?.status || 502);
  }

  const len = parseInt(res.headers.get("content-length") || "0");
  const estOrig = Math.round(len * 1.7);
  const saved = estOrig - len;
  if (saved > 0) localStats.bytesSaved += saved;
  if (debug) console.log(`💾 Size: ${len} | Saved: ${saved}`);

  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });
  return addHeaders(res, start, res.url.includes("wsrv") ? "MISS-COMPRESSED" : "MISS-DIRECT", q);
}

// ========== RAW IMAGE (MASK MODE) ==========
async function serveRawImage(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const referer = getRefererForHost(parsed.hostname, targetUrl);
    const res = await fetch(targetUrl, {
      headers: {
        Referer: referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
        Accept: "image/*,*/*;q=0.8",
      },
      cf: { cacheEverything: false },
    });
    const hdr = new Headers(res.headers);
    hdr.set("Access-Control-Allow-Origin", "*");
    hdr.delete("Content-Encoding");
    hdr.delete("Content-Length");
    return new Response(res.body, { status: res.status, headers: hdr });
  } catch (e) {
    console.error("❌ Mask fetch failed:", e);
    return errorResponse("Mask fetch failed", 500);
  }
}

// ========== HELPERS ==========
function addHeaders(res, start, cache, q) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Cache-Control", "public, max-age=604800");
  h.set("X-Cache", cache);
  h.set("X-Quality", q);
  h.set("X-Response-Time", `${Date.now() - start}ms`);
  return new Response(res.body, { status: res.status, headers: h });
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function errorResponse(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg, status }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ========== KV + UI ==========
async function updateStats(env, delta) {
  for (const k in delta) localStats[k] = (localStats[k] || 0) + (delta[k] || 0);
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;
  try {
    const kv = (await env.KV_STATS.get("stats", { type: "json" })) || { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    for (const k in localStats) kv[k] = (kv[k] || 0) + localStats[k];
    await env.KV_STATS.put("stats", JSON.stringify(kv));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) { console.error("❌ KV update failed:", err); }
}

async function showStatsPage(env) {
  const s = (await env.KV_STATS.get("stats", { type: "json" })) || { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
  const mb = (s.bytesSaved / 1024 / 1024).toFixed(2);
  const hit = s.requests ? ((s.cacheHits / s.requests) * 100).toFixed(1) : 0;
  return new Response(`<h1>📊 Bandwidth Hero v4.7</h1><p>Req: ${s.requests}</p><p>Hits: ${s.cacheHits} (${hit}%)</p><p>Saved: ${mb} MB</p>`, { headers: { "Content-Type": "text/html" } });
}

function getWebInterface() {
  return new Response(`<h2>⚡ Bandwidth Hero Proxy v4.7</h2><p>Usage: ?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&debug=1</p><ul><li>Auto wsrv + masked compression</li><li>Referer bypass</li></ul>`, { headers: { "Content-Type": "text/html" } });
}

