// 🚀 Bandwidth Hero Cloudflare Worker v3.6 (CDN Support + Referer Protection)
// ✅ Safe for Cloudflare Free Plan
// ✅ Tachiyomi + Bandwidth Hero compatible
// ✅ Automatic fallback for 400/403 wsrv.nl errors
// ✅ CDN domain mapping for manga sites
// ✅ Dedup-safe + enhanced logging

// =================== GLOBALS ===================
let localStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
};
let lastFlushTime = Date.now();
const pendingRequests = new Map();

// =================== REFERER WHITELIST ===================
// Add more domains here as needed
const ALLOWED_REFERERS = [
  'likemanga.ink',
  'mangabuddy.com',
  'mangapill.com',
  'weebcentral.com',
  'manhwaclan.com',
  'mgeko.cc',
  'mangareader.to',
  // Add more domains below:
  
];

// =================== CDN MAPPING ===================
// Maps CDN domains to their parent sites for proper referer injection
const CDN_TO_SITE_MAP = {
  // Cloudflare CDN patterns
  'images.mangabuddy.com': 'mangabuddy.com',
  'cdn.likemanga.ink': 'likemanga.ink',
  'cdn.readdetectiveconan.com': 'mangapill.com',
  'cdn.weebcentral.com': 'weebcentral.com',
  'cdn.manhwaclan.com': 'manhwaclan.com',
  'img.mgeko.cc': 'mgeko.cc',
  'cdn.mangareader.to': 'mangareader.to',
  
  // Generic CDN patterns (add specific mappings as you discover them)
  // 'i0.wp.com': 'mangasite.com', // Example for WordPress CDN
  // 'imgur.com': 'mangasite.com', // Example for Imgur hosting
};

// =================== LOGGING HELPERS ===================
function shortKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.split('/').pop().slice(0, 15)}`;
  } catch {
    return url.slice(0, 20);
  }
}

// =================== REFERER VALIDATION ===================
function isRefererAllowed(referer) {
  if (!referer) return false;
  try {
    const refererHost = new URL(referer).hostname.replace(/^www\./, '').toLowerCase();
    return ALLOWED_REFERERS.some(domain => 
      refererHost === domain.toLowerCase() || refererHost.endsWith(`.${domain.toLowerCase()}`)
    );
  } catch {
    return false;
  }
}

function getSmartReferer(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
    
    // Check if this is a known CDN domain
    for (const [cdnDomain, parentSite] of Object.entries(CDN_TO_SITE_MAP)) {
      if (hostname === cdnDomain.toLowerCase() || hostname.endsWith(`.${cdnDomain.toLowerCase()}`)) {
        console.log(`🔗 [CDN] Mapped ${hostname} → ${parentSite}`);
        return `https://${parentSite}/`;
      }
    }
    
    // Check if the hostname matches an allowed referer directly
    const matchedDomain = ALLOWED_REFERERS.find(domain => 
      hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`)
    );
    
    if (matchedDomain) {
      return `https://${matchedDomain}/`;
    }
    
    // Fallback: try to detect common CDN patterns and guess parent domain
    if (hostname.includes('cdn') || hostname.includes('img') || hostname.includes('images')) {
      // Extract base domain (e.g., cdn.example.com → example.com)
      const parts = hostname.split('.');
      if (parts.length >= 2) {
        const baseDomain = parts.slice(-2).join('.');
        const possibleParent = ALLOWED_REFERERS.find(d => d.toLowerCase().includes(baseDomain));
        if (possibleParent) {
          console.log(`🔍 [AUTO-CDN] Detected ${hostname} → ${possibleParent}`);
          return `https://${possibleParent}/`;
        }
      }
    }
    
    return null;
  } catch {
    return null;
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

    // =================== REFERER CHECK ===================
    const referer = request.headers.get('Referer') || request.headers.get('Origin');
    if (!isRefererAllowed(referer)) {
      console.warn(`🚫 [BLOCKED] Invalid referer: ${referer || 'none'}`);
      return errorResponse('Access denied: Invalid referer', 403);
    }

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
      logError("wsrv.nl fetch", err);
      return await handleDirectImage(targetUrl, browserUA, env, ctx, startTime);
    }
  });
}

// --- Direct fetch fallback ---
async function handleDirectImage(targetUrl, ua, env, ctx, startTime) {
  const cache = caches.default;
  const cacheKey = new Request(`direct-${targetUrl}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    logCacheHit("HIT-DIRECT", Date.now() - startTime);
    return addHeaders(cached, startTime, "HIT-DIRECT", 100);
  }

  try {
    const smartReferer = getSmartReferer(targetUrl);
    const response = await fetchWithTimeout(
      targetUrl,
      {
        headers: {
          "User-Agent": ua,
          Referer: smartReferer || new URL(targetUrl).origin + "/",
          Accept: "image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      },
      10000
    );

    if (!response.ok) throw new Error("Direct fetch failed");

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    await updateStats(env, { requests: 1, cacheMisses: 1 });
    console.log("✅ [DIRECT] Success");
    return addHeaders(response, startTime, "MISS-DIRECT", 100);
  } catch (err) {
    logError("Direct Fetch", err);
    return errorResponse("Failed to fetch image", 502);
  }
}

// --- Deduplication with safety ---
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

// --- Update KV every 2 minutes ---
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
<p style="font-size:12px;color:gray">Auto updates every 2 min.</p>
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
  if (wsrvUrl) headers.set("X-WSRV", wsrvUrl);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  return new Response(response.body, { status: response.status, headers });
}
function getWebInterface() {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚡ Bandwidth Hero Proxy</h2>
      <p>Use: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
      <p>Stats: <a href="/stats">/stats</a></p>
      <p>Reset: <a href="/reset">/reset</a></p>
      <hr>
      <h3>🔒 Protected Sites (${ALLOWED_REFERERS.length})</h3>
      <ul>${ALLOWED_REFERERS.map(d => `<li>${d}</li>`).join('')}</ul>
      <h3>🌐 CDN Mappings (${Object.keys(CDN_TO_SITE_MAP).length})</h3>
      <ul>${Object.entries(CDN_TO_SITE_MAP).map(([cdn, site]) => `<li><code>${cdn}</code> → ${site}</li>`).join('')}</ul>
    </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

