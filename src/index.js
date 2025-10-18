// 🚀 Bandwidth Hero Cloudflare Worker (Free Plan Optimized v2.1)
// ✅ Dedup + Rate Limit for Tachiyomi bursts
// ✅ KV flush every 2 minutes
// ✅ Safe for Cloudflare Free Plan

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// In-memory dedup + rate limiter
const pendingRequests = new Map();
let lastRequestTimes = [];
const MAX_REQ_PER_MIN = 45; // soft rate limit
const MAX_CONCURRENT = 10;
let activeRequests = 0;

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleCORS();

    // ===== ROUTES =====
    if (url.pathname === "/stats") return await showStatsPage(env);
    if (url.pathname === "/health") return showHealth();
    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset.", { headers: { "Content-Type": "text/plain" } });
    }

    // Default interface
    if (!url.searchParams.get("url")) return getWebInterface();

    try {
      return await handleImageRequest(request, env, ctx, startTime);
    } catch (err) {
      console.error("❌ Worker error:", err);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// =================== ROUTE HELPERS ===================

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function errorResponse(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg, status, timestamp: new Date().toISOString() }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function showHealth() {
  return new Response(
    JSON.stringify(
      {
        status: "ok",
        activeRequests,
        pendingRequests: pendingRequests.size,
        requestsLastMinute: lastRequestTimes.length,
        timestamp: new Date().toISOString(),
      },
      null,
      2
    ),
    { headers: { "Content-Type": "application/json" } }
  );
}
// =================== IMAGE HANDLER ===================

async function handleImageRequest(request, env, ctx, startTime) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) return errorResponse("Missing 'url' parameter", 400);

  const bw = url.searchParams.get("bw") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";

  // --- Simple rate limit (wsrv.nl safe for free use) ---
  const now = Date.now();
  lastRequestTimes = lastRequestTimes.filter(t => now - t < 60000);
  if (lastRequestTimes.length >= MAX_REQ_PER_MIN) {
    const delay = 500 + Math.random() * 500;
    console.log(`⏳ Too many requests, delaying ${delay.toFixed(0)}ms`);
    await new Promise(r => setTimeout(r, delay));
  }
  lastRequestTimes.push(now);

  // --- Deduplicate concurrent requests for same URL ---
  const dedupKey = `${targetUrl}-${quality}-${jpeg ? "jpg" : "webp"}-${bw}`;
  if (pendingRequests.has(dedupKey)) {
    console.log("🕓 Waiting for duplicate request...");
    return pendingRequests.get(dedupKey);
  }

  const promise = (async () => {
    // Limit concurrency to prevent worker overload
    while (activeRequests >= MAX_CONCURRENT) {
      await new Promise(r => setTimeout(r, 100));
    }
    activeRequests++;

    try {
      const wsrvParams = new URLSearchParams({
        url: targetUrl,
        q: quality.toString(),
        output: jpeg ? "jpg" : "webp",
      });
      if (bw) wsrvParams.set("il", "");
      const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
      const cacheKey = new Request(`${wsrvUrl}-q${quality}`);
      const cache = caches.default;

      // ---- Cache Lookup ----
      const cached = await cache.match(cacheKey);
      if (cached) {
        await updateStats(env, { requests: 1, cacheHits: 1 });
        return addHeaders(cached, startTime, "HIT", quality);
      }

      // ---- Fetch with Retry / Backoff ----
      let response;
      for (let i = 0; i < 3; i++) {
        response = await fetch(wsrvUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Safari/537.36",
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
          cf: { cacheEverything: true, cacheTtl: 604800 },
        });
        if (response.status !== 429) break;
        console.warn(`⚠️ wsrv.nl rate-limited, retrying (${i + 1}/3)...`);
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }

      // ---- Fallback if wsrv.nl fails ----
      const ctype = response.headers.get("content-type") || "";
      if (!response.ok || !ctype.startsWith("image/")) {
        console.warn(`⚠️ wsrv.nl failed: ${response.status} ${ctype}`);
        return await handleDirectImage(targetUrl, env, ctx, startTime);
      }

      // ---- Cache and track savings ----
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      const len = parseInt(response.headers.get("content-length") || "0");
      const estimatedOriginal = Math.round(len * 1.6);
      const bytesSaved = estimatedOriginal - len;
      await updateStats(env, { requests: 1, cacheMisses: 1, bytesSaved });

      return addHeaders(response, startTime, "MISS", quality);
    } catch (err) {
      console.error("❌ Image fetch error:", err);
      return errorResponse(err.message, 500);
    } finally {
      activeRequests--;
      pendingRequests.delete(dedupKey);
    }
  })();

  pendingRequests.set(dedupKey, promise);
  return promise;
}

// =================== DIRECT FETCH FALLBACK ===================

async function handleDirectImage(targetUrl, env, ctx, startTime) {
  const cache = caches.default;
  const cacheKey = new Request(`direct-${targetUrl}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT-DIRECT", 100);
  }

  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "image/*",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  if (!response.ok) return errorResponse("Direct fetch failed", response.status);

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });
  return addHeaders(response, startTime, "MISS-DIRECT", 100);
}
// =================== STATS + FLUSH HANDLING ===================

async function updateStats(env, delta) {
  for (const key in delta) localStats[key] += delta[key] || 0;

  // Flush every 2 minutes (safe for KV free tier)
  if (Date.now() - lastFlushTime < 2 * 60 * 1000) return;

  try {
    const kvData =
      (await env.KV_STATS.get("stats", { type: "json", cacheTtl: 60 })) || {
        requests: 0,
        cacheHits: 0,
        cacheMisses: 0,
        bytesSaved: 0,
        lastReset: new Date().toISOString(),
      };

    for (const key in localStats)
      kvData[key] = (kvData[key] || 0) + localStats[key];

    await env.KV_STATS.put("stats", JSON.stringify(kvData));
    console.log("💾 KV flushed:", kvData);

    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    console.error("❌ KV update failed:", err);
  }
}

// =================== STATS PAGE ===================

async function showStatsPage(env) {
  const stats =
    (await env.KV_STATS.get("stats", { type: "json", cacheTtl: 60 })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: "N/A",
    };

  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate =
    stats.requests > 0
      ? ((stats.cacheHits / stats.requests) * 100).toFixed(1)
      : 0;

  return new Response(
    `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>📊 Bandwidth Hero Stats</title>
<style>
  body { font-family: system-ui; background:#f3f4f6; color:#111;
         display:flex; justify-content:center; padding:40px; }
  .card { background:white; border-radius:20px; padding:30px;
          width:400px; box-shadow:0 10px 25px rgba(0,0,0,0.1); }
  h1 { text-align:center; color:#6366f1; margin-bottom:20px; }
  .item { margin:12px 0; }
  .bar { height:6px; background:#eee; border-radius:4px; overflow:hidden; }
  .bar div { height:100%; background:#6366f1; width:${hitRate}%; }
  p small { color:#666; }
</style>
</head>
<body>
  <div class="card">
    <h1>📊 Bandwidth Hero Stats</h1>
    <div class="item"><b>Total Requests:</b> ${stats.requests}</div>
    <div class="item"><b>Cache Hits:</b> ${stats.cacheHits} (${hitRate}%)</div>
    <div class="bar"><div></div></div>
    <div class="item"><b>Cache Misses:</b> ${stats.cacheMisses}</div>
    <div class="item"><b>Data Saved:</b> ${savedMB} MB</div>
    <div class="item"><b>Last Reset:</b> ${stats.lastReset}</div>
    <p><small>Auto-flushes every 2 minutes · Refresh to update</small></p>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// =================== ADD HEADERS HELPER ===================

function addHeaders(response, startTime, cacheStatus, quality) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality.toString());
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Powered-By", "Bandwidth-Hero-Free-v2.1");
  return new Response(response.body, { status: response.status, headers });
}

// =================== WEB INTERFACE ===================

function getWebInterface() {
  return new Response(
    `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>⚡ Bandwidth Hero Proxy</title>
<style>
  body{font-family:system-ui;background:#eef2ff;color:#111;
       display:flex;justify-content:center;align-items:center;
       height:100vh;text-align:center;}
  .box{background:white;padding:40px;border-radius:15px;
       box-shadow:0 10px 25px rgba(0,0,0,0.1);max-width:450px;}
  code{background:#f1f5f9;padding:4px 8px;border-radius:6px;}
  a{color:#4f46e5;text-decoration:none;font-weight:600;}
</style>
</head>
<body>
  <div class="box">
    <h1>⚡ Bandwidth Hero Proxy (v2.1)</h1>
    <p>Use this as Tachiyomi or Bandwidth Hero proxy:</p>
    <p><code>?url=&lt;IMAGE_URL&gt;&amp;l=75&amp;jpg=0&amp;bw=0</code></p>
    <p><a href="/stats">📊 View Stats</a> | <a href="/health">💚 Health</a></p>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
