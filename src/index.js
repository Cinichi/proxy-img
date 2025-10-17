// 🚀 Bandwidth Hero Cloudflare Worker – Stable + Persistent Stats (v2)
// ✅ Tachiyomi compatible
// ✅ Persistent KV stats (no stuck values)
// ✅ Compression, fallback, cache, /stats dashboard

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    // ---- /stats and /stats/reset endpoints ----
    if (url.pathname === "/stats/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset complete", { status: 200 });
    }
    if (url.pathname === "/stats") {
      return await handleStats(request, env);
    }

    // ---- CORS ----
    if (request.method === "OPTIONS") return handleCORS();

    if (!["GET", "HEAD"].includes(request.method)) {
      return errorResponse("Method not allowed", 405);
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return getWebInterface();

    // ---- Validate target ----
    try {
      const parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return errorResponse("Invalid protocol", 400);
      }
    } catch {
      return errorResponse("Invalid URL format", 400);
    }

    // ---- Parse Tachiyomi / Bandwidth Hero params ----
    const bw = url.searchParams.get("bw") === "1";
    const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
    const jpgParam = url.searchParams.get("jpg");
    const jpegParam = url.searchParams.get("jpeg");
    const jpeg = jpgParam === "1" || jpegParam === "1";
    const debug = url.searchParams.get("debug") === "1";

    console.log(`📥 ${targetUrl} | q=${quality}, bw=${bw}, jpeg=${jpeg}`);

    // ---- Count request ----
    await incrementKVStat(env, "requests");

    try {
      const response = await handleCompressedImage(
        targetUrl,
        quality,
        bw,
        jpeg,
        startTime,
        env,
        debug
      );
      return response;
    } catch (err) {
      console.error("❌ Fatal:", err.message);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// ---- Main compression handler ----
async function handleCompressedImage(targetUrl, quality, grayscale, jpeg, startTime, env, debug) {
  const wsrvParams = new URLSearchParams({
    url: targetUrl,
    q: quality.toString(),
    output: jpeg ? "jpg" : "webp",
    default: "1",
    n: "-1",
  });
  if (grayscale) wsrvParams.set("il", "");

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
  const cache = caches.default;
  const cacheKey = new Request(`${wsrvUrl}-q${quality}-${jpeg ? "jpg" : "webp"}`);

  const cached = await cache.match(cacheKey);
  if (cached && !debug) {
    await incrementKVStat(env, "cacheHits");
    return addHeaders(cached, startTime, "HIT-COMPRESSED", quality, wsrvUrl);
  }

  await incrementKVStat(env, "cacheMisses");
  console.log("❌ Cache MISS - fetching wsrv.nl");

  const browserUA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36";

  const response = await fetch(wsrvUrl, {
    headers: {
      "User-Agent": browserUA,
      "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.startsWith("image/")) {
    console.warn(`⚠️ wsrv.nl failed (${response.status})`);
    return await handleDirectImage(targetUrl, browserUA, startTime, env);
  }

  // ---- Track bytes saved ----
  const orig = parseInt(response.headers.get("x-upstream-response-length") || "0");
  const comp = parseInt(response.headers.get("content-length") || "0");
  if (orig && comp && orig > comp) {
    await addKVBytesSaved(env, orig - comp);
  }

  // ---- Cache it ----
  const clone = response.clone();
  await cache.put(cacheKey, clone);

  return addHeaders(response, startTime, "MISS-COMPRESSED", quality, wsrvUrl);
}

// ---- Fallback direct fetch ----
async function handleDirectImage(targetUrl, ua, startTime, env) {
  const cache = caches.default;
  const cacheKey = new Request(`direct-${targetUrl}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    await incrementKVStat(env, "cacheHits");
    return addHeaders(cached, startTime, "HIT-DIRECT", 100);
  }

  const response = await fetch(targetUrl, {
    headers: { "User-Agent": ua, "Referer": new URL(targetUrl).origin + "/" },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  if (!response.ok) return errorResponse(`Fetch failed: ${response.status}`, response.status);
  const clone = response.clone();
  await cache.put(cacheKey, clone);
  return addHeaders(response, startTime, "MISS-DIRECT", 100);
}
// ---- Response helpers ----
function addHeaders(response, startTime, cacheStatus, quality = 0, wsrvUrl = "") {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Quality", quality);
  headers.set("X-Powered-By", "Bandwidth-Hero+Stats");
  if (cacheStatus.includes("COMPRESSED")) headers.set("X-Compressed-By", "wsrv.nl");
  return new Response(response.body, { status: response.status, headers });
}

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message, status, time: new Date().toISOString() }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

// ---- Web UI ----
function getWebInterface() {
  return new Response(
    `<html><head><meta charset="utf-8"/><title>⚡ Bandwidth Hero Proxy</title>
<style>body{font-family:sans-serif;text-align:center;padding:30px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.container{max-width:800px;margin:auto;background:#fff;color:#000;border-radius:15px;padding:40px}
a{color:#667eea;text-decoration:none;font-weight:bold}</style></head>
<body><div class="container">
<h1>⚡ Bandwidth Hero Proxy</h1>
<p>Optimized for Tachiyomi & Bandwidth Hero</p>
<p><a href="/stats">📊 View Live Stats</a></p>
</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
// ---- Reliable KV Stats ----
async function incrementKVStat(env, key) {
  const stats = await getFreshStats(env);
  stats[key] = (stats[key] || 0) + 1;
  await saveStats(env, stats);
}

async function addKVBytesSaved(env, bytes) {
  const stats = await getFreshStats(env);
  stats.bytesSaved = (stats.bytesSaved || 0) + bytes;
  await saveStats(env, stats);
}

async function getFreshStats(env) {
  const raw = await env.KV_STATS.get("stats", { type: "json", cacheTtl: 0 });
  if (raw) return raw;
  const init = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesSaved: 0,
    lastReset: new Date().toISOString(),
  };
  await saveStats(env, init);
  return init;
}

async function saveStats(env, stats) {
  stats.lastUpdated = new Date().toISOString();
  await env.KV_STATS.put("stats", JSON.stringify(stats), {
    expirationTtl: 60 * 60 * 24 * 365,
  });
}
// ---- /stats dashboard ----
async function handleStats(request, env) {
  const url = new URL(request.url);
  const jsonMode = url.searchParams.get("json") === "1";
  const stats = await getFreshStats(env);
  if (jsonMode) {
    return new Response(JSON.stringify(stats, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return new Response(renderStatsHTML(stats), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderStatsHTML(stats) {
  const hitRate = stats.requests
    ? ((stats.cacheHits / stats.requests) * 100).toFixed(1)
    : 0;
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"/><title>📊 Bandwidth Hero Stats</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fa;color:#222;padding:30px}
.container{max-width:900px;margin:auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 10px 25px rgba(0,0,0,0.1)}
h1{color:#4f46e5}
.stat{margin:20px 0;padding:15px;background:#f9fafb;border-radius:10px;font-size:1.2em}
.bar{height:10px;background:#e0e0e0;border-radius:6px;overflow:hidden;margin-top:5px}
.fill{height:10px;background:linear-gradient(90deg,#4f46e5,#7c3aed)}
</style></head>
<body>
<div class="container">
<h1>📊 Bandwidth Hero Worker Stats</h1>
<div class="stat">Total Requests: <strong>${stats.requests}</strong></div>
<div class="stat">Cache Hits: <strong>${stats.cacheHits}</strong> (${hitRate}%)
<div class="bar"><div class="fill" style="width:${hitRate}%"></div></div></div>
<div class="stat">Cache Misses: <strong>${stats.cacheMisses}</strong></div>
<div class="stat">Data Saved: <strong>${savedMB} MB</strong></div>
<div class="stat">Last Reset: ${new Date(stats.lastReset).toLocaleString()}</div>
<p style="margin-top:25px;color:#666">Auto-saves stats in Cloudflare KV. Refresh to update.</p>
</div></body></html>`;
}
