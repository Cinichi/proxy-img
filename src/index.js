// 🚀 Bandwidth Hero Cloudflare Worker - Optimized for Free Plan
// ✅ Uses local in-memory stats with periodic KV flush (every 2 minutes)
// ✅ Keeps Tachiyomi & Bandwidth Hero support intact
// ✅ Safe for Cloudflare KV free tier

let localStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
};
let lastFlushTime = Date.now();

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    // --- Handle CORS preflight ---
    if (request.method === "OPTIONS") return handleCORS();

    // --- Routes ---
    if (url.pathname === "/stats") {
      return await showStatsPage(env);
    }

    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset.", { headers: { "Content-Type": "text/plain" } });
    }

    if (!url.searchParams.get("url")) return getWebInterface();

    try {
      return await handleImageRequest(request, env, ctx, startTime);
    } catch (err) {
      console.error("❌ Worker error:", err);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// =================== HELPERS ===================

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
async function handleImageRequest(request, env, ctx, startTime) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const bw = url.searchParams.get("bw") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
  const jpgParam = url.searchParams.get("jpg");
  const jpegParam = url.searchParams.get("jpeg");
  const jpeg = jpgParam === "1" || jpegParam === "1";
  const debug = url.searchParams.get("debug") === "1";

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

  // ---- Cache Lookup ----
  const cached = await cache.match(cacheKey);
  if (cached) {
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT", quality, wsrvUrl);
  }

  // ---- Fetch from wsrv.nl ----
  const response = await fetch(wsrvUrl, {
    headers: {
      "User-Agent": browserUA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
    console.warn("⚠️ wsrv.nl fetch failed:", response.status);
    return await handleDirectImage(targetUrl, browserUA, env, ctx, startTime);
  }

  // ---- Cache it ----
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  // ---- Estimate data saved ----
  const contentLength = parseInt(response.headers.get("content-length") || "0");
  const estimatedOriginal = Math.round(contentLength * 1.7); // assume 40% compression
  const bytesSaved = estimatedOriginal - contentLength;

  await updateStats(env, { requests: 1, cacheMisses: 1, bytesSaved });

  return addHeaders(response, startTime, "MISS", quality, wsrvUrl);
}

async function handleDirectImage(targetUrl, ua, env, ctx, startTime) {
  const cache = caches.default;
  const cacheKey = new Request(`direct-${targetUrl}`);
  const cached = await cache.match(cacheKey);
  if (cached) return addHeaders(cached, startTime, "HIT-DIRECT", 100);

  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": ua,
      Referer: new URL(targetUrl).origin + "/",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  if (!response.ok) return errorResponse("Direct fetch failed", response.status);

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, startTime, "MISS-DIRECT", 100);
}
async function updateStats(env, delta) {
  for (const key in delta) localStats[key] += delta[key] || 0;

  // flush only every 2 minutes
  if (Date.now() - lastFlushTime < 2 * 60 * 1000) return;

  try {
    const kvData = (await env.KV_STATS.get("stats", { type: "json", cacheTtl: 60 })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: new Date().toISOString(),
    };

    for (const key in localStats) kvData[key] = (kvData[key] || 0) + localStats[key];

    await env.KV_STATS.put("stats", JSON.stringify(kvData));
    console.log("💾 KV flushed:", kvData);

    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    console.error("❌ KV update failed:", err);
  }
}

async function showStatsPage(env) {
  const stats = (await env.KV_STATS.get("stats", { type: "json", cacheTtl: 60 })) || {
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
<!DOCTYPE html>
<html>
<head>
  <title>📊 Bandwidth Hero Worker Stats</title>
  <style>
    body { font-family: system-ui; background: #f5f6fa; color: #222; display: flex; justify-content: center; padding: 40px; }
    .card { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); width: 400px; }
    h1 { font-size: 1.5em; color: #6c63ff; text-align: center; }
    .item { margin: 15px 0; }
    strong { color: #111; }
    .bar { height: 6px; background: #eee; border-radius: 4px; overflow: hidden; }
    .bar div { height: 100%; background: #6c63ff; width: ${hitRate}%; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📊 Bandwidth Hero Worker Stats</h1>
    <div class="item"><strong>Total Requests:</strong> ${stats.requests}</div>
    <div class="item"><strong>Cache Hits:</strong> ${stats.cacheHits} (${hitRate}%)</div>
    <div class="bar"><div></div></div>
    <div class="item"><strong>Cache Misses:</strong> ${stats.cacheMisses}</div>
    <div class="item"><strong>Data Saved:</strong> ${savedMB} MB</div>
    <div class="item"><strong>Last Reset:</strong> ${stats.lastReset}</div>
    <p style="color:gray;">Auto-saves every 2 minutes. Refresh to update.</p>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
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
      <h2>⚡ Bandwidth Hero Proxy (Optimized)</h2>
      <p>Use: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
      <p>Stats: <a href="/stats">/stats</a></p>
      <p>Reset: <a href="/reset">/reset</a></p>
    </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
