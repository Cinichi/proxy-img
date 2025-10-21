// 🚀 Bandwidth Hero Cloudflare Worker v3.5.1 (Direct Fetch Fix Edition)
// ✅ Fixes wsrv.nl 404 + direct fetch fails
// ✅ Safe for Cloudflare Free Plan
// ✅ Tachiyomi + Bandwidth Hero compatible
// ✅ Enhanced logging + caching

// =================== GLOBALS ===================
let localStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
};
let lastFlushTime = Date.now();
const pendingRequests = new Map();

// =================== LOGGING HELPERS ===================
function shortKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.split('/').pop().slice(0, 15)}`;
  } catch {
    return url.slice(0, 20);
  }
}
function logFetchStart(url, quality, bw, jpeg) {
  console.log(`📥 [REQ] ${shortKey(url)} | q=${quality}${bw ? " bw" : ""}${jpeg ? " jpg" : ""}`);
}
function logCacheHit(cacheStatus, ms) {
  console.log(`✅ [CACHE] ${cacheStatus} | ${ms}ms`);
}
function logWsrvFail(status, type) {
  console.warn(`⚠️ [WSRV] ${status} ${type}`);
}
function logFallback(reason) {
  console.warn(`🔄 [FALLBACK] ${reason}`);
}
function logDedup(waiting, key) {
  if (waiting)
    console.log(`🕓 [DEDUP] Waiting for existing fetch (${key.slice(0, 32)}...)`);
  else
    console.log(`🧵 [DEDUP] New fetch started (${key.slice(0, 32)}...)`);
}
function logStatsUpdate(stats) {
  console.log(
    `📊 [STATS] Req:${stats.requests} Hit:${stats.cacheHits} Miss:${stats.cacheMisses} Saved:${(
      stats.bytesSaved / (1024 * 1024)
    ).toFixed(2)}MB`
  );
}
function logCompression(orig, comp) {
  const saved = orig - comp;
  const percent = ((saved / orig) * 100).toFixed(1);
  console.log(`💾 [COMPRESS] ${orig}B → ${comp}B | Saved ${percent}%`);
}
function logError(context, err, url) {
  console.error(`❌ [ERROR] ${context}:`, err.message || err, url || "");
}

// =================== MAIN HANDLER ===================
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleCORS();
    if (url.pathname === "/stats") return await showStatsPage(env);
    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset.", { headers: { "Content-Type": "text/plain" } });
    }

    if (!url.searchParams.get("url")) return getWebInterface();

    try {
      return await handleImageRequest(request, env, ctx, startTime);
    } catch (err) {
      logError("Worker", err);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// =================== IMAGE HANDLING ===================
async function handleImageRequest(request, env, ctx, startTime) {
  const url = new URL(request.url);

  // ✅ Decode once to prevent wsrv.nl 404
  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url.searchParams.get("url"));
  } catch {
    targetUrl = url.searchParams.get("url");
  }

  const bw = url.searchParams.get("bw") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const debug = url.searchParams.get("debug") === "1";

  logFetchStart(targetUrl, quality, bw, jpeg);

  const wsrvParams = new URLSearchParams({
    url: targetUrl,
    q: quality.toString(),
    output: jpeg ? "jpg" : "webp",
  });
  if (bw) wsrvParams.set("il", "");

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
  const browserUA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

  const cacheKey = new Request(`${wsrvUrl}-q${quality}-${jpeg ? "jpg" : "webp"}`);
  const cache = caches.default;

  // --- CACHE CHECK ---
  const cached = await cache.match(cacheKey);
  if (cached) {
    logCacheHit("HIT", Date.now() - startTime);
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT", quality, wsrvUrl);
  }

  // --- DEDUP SAFE WRAPPER ---
  return await fetchWithDedup(cacheKey, async () => {
    try {
      const response = await fetchWithTimeout(
        wsrvUrl,
        {
          headers: {
            "User-Agent": browserUA,
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
          cf: { cacheEverything: true, cacheTtl: 604800 },
        },
        10000
      );

      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.startsWith("image/")) {
        logWsrvFail(response.status, contentType);
        logFallback("wsrv.nl failed, using direct fetch");
        return await handleDirectImage(targetUrl, browserUA, env, ctx, startTime);
      }

      const size = parseInt(response.headers.get("content-length") || "0");
      const estimatedOriginal = Math.round(size * 1.7);
      const bytesSaved = estimatedOriginal - size;
      if (size > 0) logCompression(estimatedOriginal, size);

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      await updateStats(env, { requests: 1, cacheMisses: 1, bytesSaved });
      return addHeaders(response, startTime, "MISS", quality, wsrvUrl);
    } catch (err) {
      logError("wsrv.nl fetch", err, targetUrl);
      return await handleDirectImage(targetUrl, browserUA, env, ctx, startTime);
    }
  });
}

// --- Direct fetch fallback (fixed) ---
async function handleDirectImage(targetUrl, ua, env, ctx, startTime) {
  const cache = caches.default;
  const cacheKey = new Request(`direct-${targetUrl}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    logCacheHit("HIT-DIRECT", Date.now() - startTime);
    return addHeaders(cached, startTime, "HIT-DIRECT", 100);
  }

  try {
    // ✅ Add Referer spoof (fixes hotlink blocks)
    const referer = new URL(targetUrl).origin + "/";
    const response = await fetchWithTimeout(
      targetUrl,
      {
        headers: {
          "User-Agent": ua,
          "Referer": referer,
          Accept: "image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      },
      10000
    );

    if (!response.ok) throw new Error(`Direct fetch failed (${response.status})`);

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    await updateStats(env, { requests: 1, cacheMisses: 1 });
    console.log("✅ [DIRECT] Success");
    return addHeaders(response, startTime, "MISS-DIRECT", 100);
  } catch (err) {
    logError("Direct Fetch", err, targetUrl);
    return errorResponse("Failed to fetch image", 502);
  }
}

// --- Deduplication ---
async function fetchWithDedup(cacheKey, fetchFn) {
  const key = cacheKey.url;
  if (pendingRequests.has(key)) {
    logDedup(true, key);
    return await pendingRequests.get(key);
  }

  logDedup(false, key);
  const promise = (async () => {
    try {
      return await fetchFn();
    } finally {
      pendingRequests.delete(key);
    }
  })();

  pendingRequests.set(key, promise);
  return await promise;
}

// --- Timeout wrapper ---
async function fetchWithTimeout(url, options, ms = 10000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

// --- KV STATS ---
async function updateStats(env, delta) {
  for (const key in delta) localStats[key] += delta[key] || 0;
  if (Date.now() - lastFlushTime < 2 * 60 * 1000) return;

  try {
    const kvData = (await env.KV_STATS.get("stats", { type: "json" })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: new Date().toISOString(),
    };
    for (const key in localStats) kvData[key] += localStats[key];
    await env.KV_STATS.put("stats", JSON.stringify(kvData));
    logStatsUpdate(localStats);
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    logError("KV Update", err);
  }
}

// --- /stats UI ---
async function showStatsPage(env) {
  const stats = (await env.KV_STATS.get("stats", { type: "json" })) || {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesSaved: 0,
    lastReset: "N/A",
  };
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate =
    stats.requests > 0 ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) : 0;

  return new Response(
    `
<!DOCTYPE html><html><head><title>📊 Bandwidth Hero Stats</title>
<style>
body{font-family:sans-serif;background:#f5f6fa;padding:40px}
.card{background:white;padding:25px;border-radius:15px;max-width:420px;margin:auto;box-shadow:0 5px 20px rgba(0,0,0,0.1)}
h1{color:#6c63ff;text-align:center}
.item{margin:10px 0}
</style></head>
<body><div class="card">
<h1>📊 Bandwidth Hero</h1>
<div class="item"><b>Total:</b> ${stats.requests}</div>
<div class="item"><b>Cache Hits:</b> ${stats.cacheHits} (${hitRate}%)</div>
<div class="item"><b>Misses:</b> ${stats.cacheMisses}</div>
<div class="item"><b>Saved:</b> ${savedMB} MB</div>
<div class="item"><b>Last Reset:</b> ${stats.lastReset}</div>
</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// --- Misc Helpers ---
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
function errorResponse(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg, status }), {
    status,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
  });
}
function addHeaders(response, startTime, cacheStatus, quality, wsrvUrl) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality.toString());
  headers.set("X-WSRV", wsrvUrl);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  return new Response(response.body, { status: response.status, headers });
}
function getWebInterface() {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚡ Bandwidth Hero Proxy v3.5.1</h2>
      <p>Use: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
      <p>Stats: <a href="/stats">/stats</a></p>
    </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
