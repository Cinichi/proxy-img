// 🚀 Bandwidth Hero Cloudflare Worker v4.2 — Production Ready
// ✅ Enhanced Logging + Smart Retry + Adaptive Caching
// ✅ Safe for Cloudflare Free Tier
// ✅ Tachiyomi / Webtoon / Bandwidth Hero compatible

// =================== GLOBALS ===================
let localStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
  compressed: 0,
  errors: 0,
  fallbacks: 0,
  wsrvFails: 0,
};
let lastFlushTime = Date.now();
const pendingRequests = new Map();
const dedupCleanup = 30000; // 30s cleanup

// =================== CONFIG ===================
const CONFIG = {
  SMALL_IMG_SKIP: 50 * 1024, // Skip compression for images < 50KB
  WSRV_TIMEOUT: 12000, // 12s for wsrv.nl
  DIRECT_TIMEOUT: 18000, // 18s for direct fetch
  MAX_RETRIES: 2,
  BACKOFF_BASE: 800, // ms
  BACKOFF_MAX: 4000, // ms
  CACHE_TTL_MIN: 300, // 5min
  CACHE_TTL_MAX: 604800, // 7 days
  KV_FLUSH_INTERVAL: 2 * 60 * 1000, // 2min (faster updates)
  MIN_QUALITY: 40,
  MAX_QUALITY: 100,
};

// =================== LOGGING HELPERS ===================
function shortKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').filter(Boolean).pop() || '';
    return `${u.hostname.replace(/^www\./, '')}/${path.slice(0, 20)}`;
  } catch {
    return url.slice(0, 30);
  }
}

function log(level, tag, msg, meta = {}) {
  const icons = {
    req: "📥", cache: "✅", warn: "⚠️", error: "❌", 
    net: "🌐", perf: "⚡", dedup: "🕓", fallback: "🔄"
  };
  const ts = new Date().toISOString().slice(11, 23);
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console[level](`[${ts}] ${icons[tag] || '•'} [${tag.toUpperCase()}] ${msg}${metaStr}`);
}

// =================== MAIN HANDLER ===================
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return handleCORS();

    // Admin routes
    if (url.pathname === "/stats") return await showStatsPage(env);
    if (url.pathname === "/reset") return await resetStats(env);
    if (url.pathname === "/health") return healthCheck();

    // Web interface
    if (!url.searchParams.get("url")) return getWebInterface();

    // Main image handling
    try {
      const response = await handleImageRequest(request, env, ctx, startTime);
      const elapsed = Date.now() - startTime;
      log("info", "perf", `Request completed in ${elapsed}ms`);
      return response;
    } catch (err) {
      localStats.errors++;
      log("error", "error", `Handler failed: ${err.message}`, { stack: err.stack });
      return errorResponse(`Request failed: ${err.message}`, 500);
    }
  },
};

// =================== IMAGE HANDLING ===================
async function handleImageRequest(request, env, ctx, startTime) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const bw = url.searchParams.get("bw") === "1";
  const userQuality = parseInt(url.searchParams.get("l")) || 75;
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const nocache = url.searchParams.get("nocache") === "1";

  // Validate URL
  if (!isValidUrl(targetUrl)) {
    return errorResponse("Invalid URL: must be http(s) and not private IP", 400);
  }

  // Clamp quality
  const quality = Math.max(CONFIG.MIN_QUALITY, Math.min(CONFIG.MAX_QUALITY, userQuality));
  
  log("info", "req", `Processing ${shortKey(targetUrl)}`, { 
    quality, 
    format: jpeg ? "jpg" : "webp",
    bw 
  });

  // Build wsrv.nl URL
  const wsrvParams = new URLSearchParams({
    url: targetUrl,
    q: quality.toString(),
    output: jpeg ? "jpg" : "webp",
    default: targetUrl, // Fallback to original on wsrv error
  });
  if (bw) wsrvParams.set("il", "");

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
  const browserUA = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

  // Generate cache key
  const cacheKeyStr = `v4.2-${hashUrl(targetUrl)}-q${quality}-${jpeg ? "jpg" : "webp"}${bw ? "-bw" : ""}`;
  const cacheKey = new Request(`https://cache.internal/${cacheKeyStr}`);
  const cache = caches.default;

  // --- CLIENT ETAG CHECK ---
  const clientEtag = request.headers.get("if-none-match");
  if (clientEtag && !nocache) {
    const cached = await cache.match(cacheKey);
    if (cached && cached.headers.get("etag") === clientEtag) {
      log("info", "cache", "Client ETag match - 304");
      await updateStats(env, { requests: 1, cacheHits: 1 });
      return new Response(null, { status: 304 });
    }
  }

  // --- CACHE CHECK ---
  if (!nocache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      log("info", "cache", `HIT in ${Date.now() - startTime}ms`);
      await updateStats(env, { requests: 1, cacheHits: 1 });
      return addHeaders(cached.clone(), startTime, "HIT", quality);
    }
  }

  // --- DEDUP WRAPPER ---
  return await fetchWithDedup(cacheKeyStr, async () => {
    let finalResponse = null;
    let fetchSource = "none";
    let originalSize = 0;
    let compressedSize = 0;

    // STRATEGY 1: Try wsrv.nl with retry
    try {
      const wsrvResponse = await fetchWithRetry(
        wsrvUrl,
        {
          headers: {
            "User-Agent": browserUA,
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
        },
        CONFIG.WSRV_TIMEOUT,
        CONFIG.MAX_RETRIES
      );

      const contentType = wsrvResponse.headers.get("content-type") || "";
      
      if (wsrvResponse.ok && contentType.startsWith("image/") && !contentType.includes("html")) {
        finalResponse = wsrvResponse;
        fetchSource = "wsrv";
        compressedSize = parseInt(wsrvResponse.headers.get("content-length") || "0");
        
        log("info", "net", "wsrv.nl success", { size: compressedSize });

        // Try to get original size for stats
        try {
          const headResp = await fetch(targetUrl, { 
            method: "HEAD", 
            headers: { "User-Agent": browserUA },
            signal: AbortSignal.timeout(5000)
          });
          originalSize = parseInt(headResp.headers.get("content-length") || "0");
        } catch {}
      } else {
        localStats.wsrvFails++;
        log("warn", "warn", `wsrv.nl returned ${wsrvResponse.status} ${contentType}`);
      }
    } catch (err) {
      localStats.wsrvFails++;
      log("warn", "warn", `wsrv.nl failed: ${err.message}`);
    }

    // STRATEGY 2: Fallback to direct fetch
    if (!finalResponse) {
      log("info", "fallback", "Attempting direct fetch");
      localStats.fallbacks++;

      try {
        const directResponse = await fetchWithRetry(
          targetUrl,
          {
            headers: {
              "User-Agent": browserUA,
              Referer: new URL(targetUrl).origin + "/",
              Accept: "image/*,*/*;q=0.8",
            },
          },
          CONFIG.DIRECT_TIMEOUT,
          CONFIG.MAX_RETRIES
        );

        const contentType = directResponse.headers.get("content-type") || "";
        
        if (directResponse.ok && contentType.startsWith("image/")) {
          finalResponse = directResponse;
          fetchSource = "direct";
          originalSize = compressedSize = parseInt(directResponse.headers.get("content-length") || "0");
          
          log("info", "net", "Direct fetch success", { size: compressedSize });
        }
      } catch (err) {
        log("error", "error", `Direct fetch failed: ${err.message}`);
      }
    }

    // FAILURE: Both strategies failed
    if (!finalResponse) {
      throw new Error("All fetch strategies failed");
    }

    // --- SIZE CHECK: Skip caching tiny images ---
    if (compressedSize > 0 && compressedSize < CONFIG.SMALL_IMG_SKIP) {
      log("warn", "warn", `Skipping cache for small image (${(compressedSize/1024).toFixed(1)}KB)`);
      await updateStats(env, { requests: 1, cacheMisses: 1 });
      return addHeaders(finalResponse, startTime, "MISS-SMALL", quality);
    }

    // --- CALCULATE SAVINGS ---
    let bytesSaved = 0;
    if (fetchSource === "wsrv" && originalSize > 0 && compressedSize > 0) {
      bytesSaved = originalSize - compressedSize;
      if (bytesSaved > 0) {
        const percent = ((bytesSaved / originalSize) * 100).toFixed(1);
        log("info", "perf", `Compressed: ${originalSize}B → ${compressedSize}B (${percent}% saved)`);
        localStats.compressed++;
      }
    } else if (fetchSource === "wsrv" && compressedSize > 0) {
      // Estimate savings (typical compression ratio)
      bytesSaved = Math.round(compressedSize * 0.4);
      localStats.compressed++;
    }

    // --- CACHE THE RESULT ---
    if (!nocache) {
      const ttl = adaptiveTTL(localStats.cacheHits);
      ctx.waitUntil(cacheWithTTL(cache, cacheKey, finalResponse.clone(), ttl));
      log("info", "cache", `Cached with TTL ${ttl}s`);
    }

    await updateStats(env, { 
      requests: 1, 
      cacheMisses: 1, 
      bytesSaved 
    });

    return addHeaders(finalResponse, startTime, `MISS-${fetchSource.toUpperCase()}`, quality);
  });
}

// =================== FETCH UTILITIES ===================
async function fetchWithRetry(url, options, timeout, maxRetries) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Exponential backoff
      if (attempt > 0) {
        const backoff = Math.min(
          CONFIG.BACKOFF_BASE * Math.pow(2, attempt - 1), 
          CONFIG.BACKOFF_MAX
        );
        log("info", "net", `Retry ${attempt}/${maxRetries} after ${backoff}ms`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      
      return await fetchWithTimeout(url, options, timeout);
    } catch (err) {
      lastError = err;
      log("warn", "warn", `Attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}`);
    }
  }
  
  throw lastError;
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  
  try {
    const response = await fetch(url, { 
      ...options, 
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Timeout after ${ms}ms`);
    }
    throw err;
  }
}

// Request deduplication with auto-cleanup
async function fetchWithDedup(key, fetchFn) {
  if (pendingRequests.has(key)) {
    log("info", "dedup", `Waiting for in-flight request: ${key.slice(0, 30)}...`);
    return await pendingRequests.get(key);
  }

  log("info", "dedup", `New fetch: ${key.slice(0, 30)}...`);
  
  const promise = (async () => {
    try {
      return await fetchFn();
    } finally {
      setTimeout(() => {
        pendingRequests.delete(key);
        log("info", "dedup", "Cleaned up pending request");
      }, dedupCleanup);
    }
  })();

  pendingRequests.set(key, promise);
  return await promise;
}

// =================== HELPER FUNCTIONS ===================
function isValidUrl(url) {
  try {
    const u = new URL(url);
    
    // Check protocol
    if (!["http:", "https:"].includes(u.protocol)) return false;
    
    // Block private IPs and localhost
    const blocked = [
      "localhost", "127.", "192.168.", "10.", 
      "172.16.", "172.17.", "172.18.", "172.19.",
      "172.20.", "172.21.", "172.22.", "172.23.",
      "172.24.", "172.25.", "172.26.", "172.27.",
      "172.28.", "172.29.", "172.30.", "172.31."
    ];
    
    return !blocked.some(pattern => u.hostname.includes(pattern));
  } catch {
    return false;
  }
}

function hashUrl(url) {
  try {
    return btoa(url).slice(0, 48).replace(/[/+=]/g, '');
  } catch {
    return url.slice(0, 48).replace(/[^a-zA-Z0-9]/g, '');
  }
}

function adaptiveTTL(cacheHits) {
  if (cacheHits > 100) return CONFIG.CACHE_TTL_MAX; // 7 days
  if (cacheHits > 50) return 86400; // 1 day
  if (cacheHits > 10) return 3600; // 1 hour
  return CONFIG.CACHE_TTL_MIN; // 5 min
}

async function cacheWithTTL(cache, key, response, ttl) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${ttl}, immutable`);
  
  const cachedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
  
  await cache.put(key, cachedResponse);
}

// =================== STATS MANAGEMENT ===================
async function updateStats(env, delta) {
  // Update local stats
  for (const key in delta) {
    if (localStats.hasOwnProperty(key)) {
      localStats[key] = (localStats[key] || 0) + (delta[key] || 0);
    }
  }

  // Flush to KV periodically
  if (Date.now() - lastFlushTime < CONFIG.KV_FLUSH_INTERVAL) return;

  try {
    const kvData = (await env.KV_STATS.get("stats", { type: "json" })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      compressed: 0,
      errors: 0,
      fallbacks: 0,
      wsrvFails: 0,
      lastReset: new Date().toISOString(),
    };

    // Merge local stats into KV
    for (const key in localStats) {
      if (key !== 'lastReset') {
        kvData[key] = (kvData[key] || 0) + localStats[key];
      }
    }

    await env.KV_STATS.put("stats", JSON.stringify(kvData));
    
    log("info", "cache", "Stats flushed to KV", { 
      requests: localStats.requests,
      saved: `${(localStats.bytesSaved / 1024).toFixed(1)}KB`
    });

    // Reset local stats
    Object.keys(localStats).forEach(k => localStats[k] = 0);
    lastFlushTime = Date.now();
  } catch (err) {
    log("error", "error", `KV flush failed: ${err.message}`);
  }
}

// =================== HTTP RESPONSES ===================
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

function healthCheck() {
  return new Response(JSON.stringify({
    status: "healthy",
    version: "4.2",
    uptime: Math.floor((Date.now() - lastFlushTime) / 1000),
    pendingRequests: pendingRequests.size,
    localStats
  }, null, 2), {
    headers: { 
      "Content-Type": "application/json",
      "Cache-Control": "no-cache"
    }
  });
}

async function resetStats(env) {
  try {
    await env.KV_STATS.delete("stats");
    Object.keys(localStats).forEach(k => localStats[k] = 0);
    log("info", "cache", "Stats reset successfully");
    return new Response("✅ Stats reset successfully", {
      headers: { "Content-Type": "text/plain" }
    });
  } catch (err) {
    return errorResponse(`Reset failed: ${err.message}`, 500);
  }
}

function errorResponse(msg, status = 500) {
  return new Response(JSON.stringify({
    error: msg,
    status,
    timestamp: new Date().toISOString()
  }, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
  });
}

function addHeaders(response, startTime, cacheStatus, quality) {
  const headers = new Headers(response.headers);
  const elapsed = Date.now() - startTime;
  const ttl = adaptiveTTL(localStats.cacheHits);
  
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", `public, max-age=${ttl}, immutable`);
  headers.set("ETag", headers.get("etag") || `"v4.2-${Date.now()}"`);
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality.toString());
  headers.set("X-Response-Time", `${elapsed}ms`);
  headers.set("X-Proxy-Version", "4.2");
  headers.set("Vary", "Accept");
  headers.set("X-Content-Type-Options", "nosniff");
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// =================== WEB INTERFACE ===================
function getWebInterface() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bandwidth Hero Proxy v4.2</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 700px;
      width: 100%;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 2em;
    }
    .version {
      color: #667eea;
      font-size: 0.9em;
      margin-bottom: 30px;
    }
    h2 {
      color: #555;
      font-size: 1.3em;
      margin: 30px 0 15px;
      border-left: 4px solid #667eea;
      padding-left: 15px;
    }
    code {
      background: #f4f4f4;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: 'Courier New', monospace;
    }
    pre {
      background: #2d2d2d;
      color: #f8f8f8;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.85em;
      line-height: 1.5;
    }
    .param { color: #4CAF50; }
    ul {
      margin: 15px 0 15px 20px;
      line-height: 1.8;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .feature {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 8px;
      border-left: 3px solid #667eea;
    }
    .links {
      display: flex;
      gap: 15px;
      margin-top: 30px;
      flex-wrap: wrap;
    }
    .links a {
      flex: 1;
      min-width: 140px;
      text-align: center;
      padding: 12px 20px;
      background: #667eea;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 500;
      transition: all 0.3s;
    }
    .links a:hover {
      background: #5568d3;
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
    }
    @media (max-width: 600px) {
      .container { padding: 30px 20px; }
      h1 { font-size: 1.5em; }
      .links { flex-direction: column; }
      .links a { min-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Bandwidth Hero Proxy</h1>
    <div class="version">v4.2 — Production Ready</div>
    
    <h2>📖 Usage</h2>
    <pre>GET /?url=<span class="param">&lt;IMAGE_URL&gt;</span>&l=<span class="param">75</span>&jpg=<span class="param">0</span>&bw=<span class="param">0</span></pre>
    
    <h2>🎛️ Parameters</h2>
    <ul>
      <li><code>url</code> — Target image URL (required)</li>
      <li><code>l</code> — Quality level 40-100 (default: 75)</li>
      <li><code>jpg</code> — Force JPEG output (default: 0, uses WebP)</li>
      <li><code>bw</code> — Grayscale mode (default: 0)</li>
      <li><code>nocache</code> — Skip caching (default: 0)</li>
    </ul>
    
    <h2>✨ Features</h2>
    <div class="features">
      <div class="feature">🚀 Smart compression via wsrv.nl</div>
      <div class="feature">💾 Adaptive TTL caching</div>
      <div class="feature">🔄 Auto-retry with backoff</div>
      <div class="feature">⚡ Request deduplication</div>
      <div class="feature">📊 Real-time statistics</div>
      <div class="feature">🎯 ETag support</div>
    </div>
    
    <div class="links">
      <a href="/stats">📊 Statistics</a>
      <a href="/health">💚 Health</a>
      <a href="/reset">🔄 Reset</a>
    </div>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function showStatsPage(env) {
  const stats = (await env.KV_STATS.get("stats", { type: "json" })) || {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesSaved: 0,
    compressed: 0,
    errors: 0,
    fallbacks: 0,
    wsrvFails: 0,
    lastReset: "N/A",
  };

  const savedMB = ((stats.bytesSaved || 0) / (1024 * 1024)).toFixed(2);
  const hitRate = stats.requests > 0 
    ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) 
    : 0;
  const avgSaved = stats.compressed > 0
    ? ((stats.bytesSaved / stats.compressed) / 1024).toFixed(1)
    : 0;
  const wsrvSuccessRate = stats.requests > 0
    ? (((stats.requests - stats.wsrvFails) / stats.requests) * 100).toFixed(1)
    : 100;

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stats — Bandwidth Hero</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      background: white;
      padding: 40px;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 0.9em;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      margin: 30px 0;
    }
    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.1);
    }
    .stat-card.green { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); }
    .stat-card.orange { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
    .stat-card.blue { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); }
    .stat-card.purple { background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%); color: #333; }
    .stat-value {
      font-size: 2.5em;
      font-weight: bold;
      margin: 10px 0;
    }
    .stat-label {
      font-size: 0.9em;
      opacity: 0.95;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .stat-sublabel {
      font-size: 0.85em;
      opacity: 0.8;
      margin-top: 5px;
    }
    .back-link {
      display: inline-block;
      margin-top: 30px;
      padding: 12px 24px;
      background: #667eea;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      transition: all 0.3s;
    }
    .back-link:hover {
      background: #5568d3;
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
    }
    @media (max-width: 600px) {
      .container { padding: 30px 20px; }
      .stat-value { font-size: 2em; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Bandwidth Hero Statistics</h1>
    <div class="subtitle">Last reset: ${stats.lastReset}</div>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Requests</div>
        <div class="stat-value">${(stats.requests || 0).toLocaleString()}</div>
      </div>
      
      <div class="stat-card green">
        <div class="stat-label">Cache Hit Rate</div>
        <div class="stat-value">${hitRate}%</div>
        <div class="stat-sublabel">${stats.cacheHits || 0} hits / ${stats.cacheMisses || 0} misses</div>
      </div>
      
      <div class="stat-card orange">
        <div class="stat-label">Bandwidth Saved</div>
        <div class="stat-value">${savedMB} MB</div>
        <div class="stat-sublabel">${stats.compressed || 0} images compressed</div>
      </div>
      
      <div class="stat-card blue">
        <div class="stat-label">Avg Savings</div>
        <div class="stat-value">${avgSaved} KB</div>
        <div class="stat-sublabel">per compressed image</div>
      </div>
      
      <div class="stat-card purple">
        <div class="stat-label">wsrv.nl Success</div>
        <div class="stat-value">${wsrvSuccessRate}%</div>
        <div class="stat-sublabel">${stats.wsrvFails || 0} failures</div>
      </div>
      
      <div class="stat-card">
        <div class="stat-label">Direct Fallbacks</div>
        <div class="stat-value">${stats.fallbacks || 0}</div>
      </div>
      
      <div class="stat-card orange">
        <div class="stat-label">Errors</div>
        <div class="stat-value">${stats.errors || 0}</div>
      </div>
      
      <div class="stat-card green">
        <div class="stat-label">Status</div>
        <div class="stat-value">✓</div>
        <div class="stat-sublabel">Operational</div>
      </div>
    </div>
    
    <a href="/" class="back-link">← Back to Home</a>
  </div>
  
  <script>
    // Auto-refresh every 30 seconds
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
