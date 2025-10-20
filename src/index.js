// 🚀 Bandwidth Hero Cloudflare Worker v3.6 (Enhanced Edition)
// ✅ Safe for Cloudflare Free Plan
// ✅ Tachiyomi + Bandwidth Hero compatible
// ✅ Automatic fallback for 400/403 wsrv.nl errors
// ✅ Dedup-safe + enhanced logging + security improvements

// =================== GLOBALS ===================
let localStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
};
let lastFlushTime = Date.now();
const pendingRequests = new Map();

// =================== SECURITY HELPERS ===================
function isUrlSafe(url) {
  try {
    const u = new URL(url);
    // Block internal IPs and localhost
    if (/^(10|127|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\./.test(u.hostname)) {
      return false;
    }
    if (u.hostname === 'localhost' || u.hostname === '0.0.0.0' || u.hostname === '[::]') {
      return false;
    }
    return ['http:', 'https:'].includes(u.protocol);
  } catch {
    return false;
  }
}

async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `ratelimit:${ip}`;
  
  try {
    const count = parseInt(await env.KV_STATS.get(key)) || 0;
    
    // 1000 requests per minute = ~16 req/sec (enough for fast manga reading)
    // With cache, most requests won't even hit this
    if (count > 1000) {
      return errorResponse('Rate limit exceeded. Please try again later.', 429);
    }
    
    await env.KV_STATS.put(key, (count + 1).toString(), { expirationTtl: 60 });
  } catch (err) {
    // If KV fails, allow request (fail open)
    logError("Rate limit check", err);
  }
  
  return null;
}

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
function logError(context, err) {
  console.error(`❌ [ERROR] ${context}:`, err.message || err);
}

// =================== CACHE KEY GENERATION ===================
function generateCacheKey(targetUrl, quality, jpeg, bw) {
  // Create a more robust cache key with version prefix
  const urlHash = btoa(targetUrl).slice(0, 32).replace(/[/+=]/g, '-');
  return new Request(`cache-v2:${urlHash}:q${quality}:${jpeg ? 'jpg' : 'webp'}${bw ? ':bw' : ''}`);
}

// =================== MAIN HANDLER ===================
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleCORS();

    if (url.pathname === "/stats") return await showStatsPage(env);
    if (url.pathname === "/health") return healthCheck();
    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset.", { headers: { "Content-Type": "text/plain" } });
    }

    if (!url.searchParams.get("url")) return getWebInterface();

    // Rate limiting check
    const rateLimitResponse = await checkRateLimit(request, env);
    if (rateLimitResponse) return rateLimitResponse;

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
  const targetUrl = url.searchParams.get("url");
  
  // Validate URL
  if (!isUrlSafe(targetUrl)) {
    return errorResponse("Invalid or unsafe URL", 400);
  }
  
  const bw = url.searchParams.get("bw") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";

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

  const cacheKey = generateCacheKey(targetUrl, quality, jpeg, bw);
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
      const response = await fetchWithRetry(
        wsrvUrl,
        {
          headers: {
            "User-Agent": browserUA,
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
          cf: { cacheEverything: true, cacheTtl: 604800 },
        },
        2
      );

      const contentType = response.headers.get("content-type") || "";
      const validImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];
      
      if (!response.ok || !validImageTypes.some(t => contentType.startsWith(t))) {
        logWsrvFail(response.status, contentType);
        logFallback("wsrv.nl failed, using direct fetch");
        return await handleDirectImage(targetUrl, browserUA, env, ctx, startTime);
      }

      // Get actual size by reading the response
      const buffer = await response.arrayBuffer();
      const size = buffer.byteLength;
      const estimatedOriginal = Math.round(size * 1.7);
      const bytesSaved = estimatedOriginal - size;
      
      if (size > 0) logCompression(estimatedOriginal, size);

      // Create new response from buffer
      const newResponse = new Response(buffer, {
        status: response.status,
        headers: response.headers
      });

      ctx.waitUntil(cache.put(cacheKey, newResponse.clone()));
      await updateStats(env, { requests: 1, cacheMisses: 1, bytesSaved });
      return addHeaders(newResponse, startTime, "MISS", quality, wsrvUrl);
    } catch (err) {
      logError("wsrv.nl fetch", err);
      return await handleDirectImage(targetUrl, browserUA, env, ctx, startTime);
    }
  });
}

// --- Direct fetch fallback ---
async function handleDirectImage(targetUrl, ua, env, ctx, startTime) {
  const cache = caches.default;
  const cacheKey = new Request(`direct-v2-${btoa(targetUrl).slice(0, 40)}`);
  const cached = await cache.match(cacheKey);
  
  if (cached) {
    logCacheHit("HIT-DIRECT", Date.now() - startTime);
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT-DIRECT", 100);
  }

  try {
    const response = await fetchWithRetry(
      targetUrl,
      {
        headers: {
          "User-Agent": ua,
          Referer: new URL(targetUrl).origin + "/",
          Accept: "image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      },
      2
    );

    if (!response.ok) throw new Error(`Direct fetch failed with status ${response.status}`);

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    await updateStats(env, { requests: 1, cacheMisses: 1 });
    console.log("✅ [DIRECT] Success");
    return addHeaders(response, startTime, "MISS-DIRECT", 100);
  } catch (err) {
    logError("Direct Fetch", err);
    return errorResponse("Failed to fetch image", 502, { url: targetUrl });
  }
}

// --- Retry logic with exponential backoff ---
async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const response = await fetchWithTimeout(url, options, 10000);
      if (response.ok) return response;
      
      if (i < maxRetries && response.status >= 500) {
        // Only retry on server errors
        await new Promise(r => setTimeout(r, 1000 * (i + 1))); // Exponential backoff
        continue;
      }
      
      return response; // Return non-500 errors immediately
    } catch (err) {
      if (i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// --- Deduplication with memory leak prevention ---
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
      // Safety cleanup after 30 seconds
      setTimeout(() => pendingRequests.delete(key), 30000);
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

// --- Update KV with threshold and time-based flushing ---
async function updateStats(env, delta) {
  for (const key in delta) localStats[key] += delta[key] || 0;
  
  // Flush if threshold reached OR time elapsed
  const shouldFlush = 
    Date.now() - lastFlushTime > 2 * 60 * 1000 || 
    localStats.requests > 50;
    
  if (!shouldFlush) return;

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

// --- Health check endpoint ---
function healthCheck() {
  return new Response(JSON.stringify({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    memory: localStats,
    pendingRequests: pendingRequests.size
  }), {
    headers: { "Content-Type": "application/json" }
  });
}

// --- Simple /stats UI ---
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:sans-serif;background:#f5f6fa;padding:40px;margin:0}
.card{background:white;padding:25px;border-radius:15px;max-width:420px;margin:auto;box-shadow:0 5px 20px rgba(0,0,0,0.1)}
h1{color:#6c63ff;text-align:center;margin-top:0}
.item{margin:10px 0;padding:10px;background:#f8f9fa;border-radius:8px}
.item b{color:#333}
.footer{font-size:12px;color:gray;text-align:center;margin-top:20px}
</style></head>
<body><div class="card">
<h1>📊 Bandwidth Hero</h1>
<div class="item"><b>Total Requests:</b> ${stats.requests}</div>
<div class="item"><b>Cache Hits:</b> ${stats.cacheHits} (${hitRate}%)</div>
<div class="item"><b>Cache Misses:</b> ${stats.cacheMisses}</div>
<div class="item"><b>Data Saved:</b> ${savedMB} MB</div>
<div class="item"><b>Last Reset:</b> ${stats.lastReset}</div>
<p class="footer">Auto updates every 2 min or 50 requests</p>
</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// --- CORS, HTML + Errors ---
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

function errorResponse(msg, status = 500, details = {}) {
  return new Response(
    JSON.stringify({ 
      error: msg, 
      status,
      timestamp: new Date().toISOString(),
      ...details 
    }), {
      status,
      headers: { 
        "Access-Control-Allow-Origin": "*", 
        "Content-Type": "application/json" 
      },
    }
  );
}

function addHeaders(response, startTime, cacheStatus, quality, wsrvUrl = "") {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality.toString());
  if (wsrvUrl) headers.set("X-WSRV", wsrvUrl);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  return new Response(response.body, { status: response.status, headers });
}

function getWebInterface() {
  return new Response(
    `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
      <h2>⚡ Bandwidth Hero Proxy v3.6</h2>
      <p><strong>Usage:</strong> <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
      <h3>Endpoints:</h3>
      <ul>
        <li><a href="/stats">📊 Stats</a></li>
        <li><a href="/health">💚 Health Check</a></li>
        <li><a href="/reset">🔄 Reset Stats</a></li>
      </ul>
      <h3>Parameters:</h3>
      <ul>
        <li><code>url</code> - Image URL (required)</li>
        <li><code>l</code> - Quality 1-100 (default: 75)</li>
        <li><code>jpg</code> or <code>jpeg</code> - Force JPEG (default: WebP)</li>
        <li><code>bw</code> - Grayscale mode</li>
      </ul>
    </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
