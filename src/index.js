// 🚀 Bandwidth Hero Cloudflare Worker - Production Ready v3.0
// ✅ Request deduplication (prevents cache stampede)
// ✅ Exponential backoff for rate limits
// ✅ Request queue with rate limiting (10 concurrent, 60/min)
// ✅ Adaptive KV flushing based on traffic patterns
// ✅ Memory safety with overflow protection
// ✅ Prefetch API for sequential reading
// ✅ Perfect for 200+ page manhwa reading

// =================== GLOBAL STATE ===================

let localStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
  compressed: 0,
  directFetch: 0,
  errors: 0,
};
let lastFlushTime = Date.now();
let isFlushingKV = false;
let flushFailureCount = 0;

// Request deduplication map
const pendingRequests = new Map();

// =================== REQUEST QUEUE ===================

class RequestQueue {
  constructor(maxConcurrent = 10, requestsPerMinute = 60) {
    this.maxConcurrent = maxConcurrent;
    this.requestsPerMinute = requestsPerMinute;
    this.activeRequests = 0;
    this.queue = [];
    this.requestTimes = [];
  }
  
  async add(fn) {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter(t => now - t < 60000);
    
    // Rate limit check
    if (this.requestTimes.length >= this.requestsPerMinute) {
      const oldestRequest = this.requestTimes[0];
      const waitTime = 60000 - (now - oldestRequest);
      console.log(`⏳ Rate limit: waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Concurrency check
    if (this.activeRequests >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    
    this.activeRequests++;
    this.requestTimes.push(Date.now());
    
    try {
      return await fn();
    } finally {
      this.activeRequests--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
  
  getStats() {
    return {
      active: this.activeRequests,
      queued: this.queue.length,
      requestsLastMinute: this.requestTimes.length
    };
  }
}

const wsrvQueue = new RequestQueue(10, 60);

// =================== MAIN HANDLER ===================

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return handleCORS();

    // Routes
    if (url.pathname === "/stats") return await showStatsPage(env);
    if (url.pathname === "/stats.json") return await showStatsJSON(env);
    if (url.pathname === "/health") return healthCheck(env);
    if (url.pathname === "/prefetch") return await handlePrefetch(request, env, ctx);
    
    if (url.pathname === "/reset") {
      if (!env.KV_STATS) return errorResponse("KV not configured", 500);
      await env.KV_STATS.delete("stats");
      localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, compressed: 0, directFetch: 0, errors: 0 };
      lastFlushTime = Date.now();
      return new Response("✅ Stats reset successfully", { 
        headers: { "Content-Type": "text/plain" } 
      });
    }

    if (!url.searchParams.get("url")) return getWebInterface();

    // Main image proxy
    try {
      return await handleImageRequest(request, env, ctx, startTime);
    } catch (err) {
      console.error("❌ Worker error:", err.message);
      await updateStats(env, ctx, { requests: 1, errors: 1 });
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// =================== IMAGE HANDLING ===================

async function handleImageRequest(request, env, ctx, startTime) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  
  // Validate URL
  if (!isValidImageUrl(targetUrl)) {
    return errorResponse("Invalid URL", 400);
  }

  const bw = url.searchParams.get("bw") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
  const jpgParam = url.searchParams.get("jpg");
  const jpegParam = url.searchParams.get("jpeg");
  const jpeg = jpgParam === "1" || jpegParam === "1";
  const debug = url.searchParams.get("debug") === "1";

  console.log(`📥 ${targetUrl.substring(0, 80)}... | q=${quality}, bw=${bw}, jpeg=${jpeg}`);

  // Build wsrv.nl URL
  const wsrvParams = new URLSearchParams({
    url: targetUrl,
    q: quality.toString(),
    output: jpeg ? "jpg" : "webp",
    default: "1",
    n: "-1",
  });
  if (bw) wsrvParams.set("il", "");

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
  const format = jpeg ? "jpg" : "webp";
  const cacheKey = new Request(`v2-${btoa(targetUrl).slice(0, 50)}-q${quality}-${format}-${bw ? 'bw' : 'c'}`);
  const cache = caches.default;

  // Cache lookup
  if (!debug) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      console.log("✅ Cache HIT");
      await updateStats(env, ctx, { requests: 1, cacheHits: 1 });
      return addHeaders(cached, startTime, "HIT-COMPRESSED", quality);
    }
  }

  console.log("❌ Cache MISS - Queue stats:", wsrvQueue.getStats());

  // Fetch with deduplication and queue
  return await fetchWithDedup(cacheKey, async () => {
    return await wsrvQueue.add(async () => {
      const browserUA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36";
      
      const response = await fetchWithBackoff(wsrvUrl, {
        headers: {
          "User-Agent": browserUA,
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cf: { cacheEverything: true, cacheTtl: 604800, polish: "off" },
      });

      const contentType = response.headers.get("content-type") || "";
      const contentLength = parseInt(response.headers.get("content-length") || "0");
      
      // Validate response
      if (!response.ok || !contentType.startsWith("image/") || contentLength === 0 || contentType.includes("text/html")) {
        console.warn(`⚠️ wsrv.nl failed: ${response.status} ${response.statusText}`);
        return await handleDirectImage(targetUrl, browserUA, env, ctx, startTime);
      }

      // Track compression
      const originalSize = parseInt(response.headers.get("x-upstream-response-length") || "0");
      const compressedSize = contentLength;
      
      let bytesSaved = 0;
      let compressionRatio = "N/A";
      
      if (originalSize && compressedSize && originalSize > compressedSize) {
        bytesSaved = originalSize - compressedSize;
        compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1) + "%";
        console.log(`💾 Compression: ${originalSize} → ${compressedSize} (saved ${compressionRatio})`);
      }

      // Cache the result
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      await updateStats(env, ctx, { 
        requests: 1, 
        cacheMisses: 1, 
        bytesSaved,
        compressed: 1
      });

      return addHeaders(response, startTime, "MISS-COMPRESSED", quality, compressionRatio);
    });
  });
}

// =================== DIRECT FETCH WITH RETRY ===================

async function handleDirectImage(targetUrl, initialUA, env, ctx, startTime) {
  console.log("🔄 Direct fetch fallback");
  
  const cache = caches.default;
  const cacheKey = new Request(`direct-v2-${btoa(targetUrl).slice(0, 50)}`);
  
  const cached = await cache.match(cacheKey);
  if (cached) {
    console.log("✅ Direct cache HIT");
    await updateStats(env, ctx, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT-DIRECT", 100);
  }

  // Multiple User-Agent retry
  const userAgents = [
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36",
  ];

  let lastError = null;
  
  for (let i = 0; i < userAgents.length; i++) {
    const ua = userAgents[i];
    console.log(`🔄 Direct attempt ${i + 1}/${userAgents.length}`);
    
    try {
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": ua,
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cf: { cacheEverything: false },
      });

      if (response.ok) {
        console.log(`✅ Direct fetch success (UA ${i + 1})`);
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        await updateStats(env, ctx, { requests: 1, cacheMisses: 1, directFetch: 1 });
        return addHeaders(response, startTime, "MISS-DIRECT", 100);
      }
      
      console.warn(`⚠️ Attempt ${i + 1} failed: ${response.status}`);
      lastError = { status: response.status, statusText: response.statusText };
      
      if (response.status === 404) break;
      if (response.status !== 403) break;
      
    } catch (err) {
      console.error(`❌ Attempt ${i + 1} error:`, err.message);
      lastError = { status: 500, statusText: err.message };
    }
  }
  
  console.error("❌ All direct attempts failed");
  await updateStats(env, ctx, { requests: 1, errors: 1 });
  
  return errorResponse(
    `Failed after ${userAgents.length} attempts: ${lastError?.status}`,
    lastError?.status || 403
  );
}

// =================== HELPER FUNCTIONS ===================

function isValidImageUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    
    // Block internal/private IPs
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || 
        hostname.startsWith("127.") || 
        hostname.startsWith("192.168.") ||
        hostname.startsWith("10.") ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

async function fetchWithDedup(cacheKey, fetchFn) {
  const key = cacheKey.url;
  
  if (pendingRequests.has(key)) {
    console.log("⏳ Dedup: Waiting for in-flight request");
    return await pendingRequests.get(key);
  }
  
  const promise = fetchFn().finally(() => {
    pendingRequests.delete(key);
  });
  
  pendingRequests.set(key, promise);
  return await promise;
}

async function fetchWithBackoff(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (response.ok) return response;
      
      // Rate limited - retry with backoff
      if (response.status === 429 && attempt < maxRetries - 1) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "0");
        const backoffMs = retryAfter * 1000 || Math.min(1000 * Math.pow(2, attempt), 8000);
        
        console.warn(`⏳ Rate limited (429), retry in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      
      return response;
      
    } catch (err) {
      if (attempt < maxRetries - 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.error(`❌ Attempt ${attempt + 1} failed, retry in ${backoffMs}ms:`, err.message);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      } else {
        throw err;
      }
    }
  }
}

// =================== STATS MANAGEMENT ===================

function detectTrafficLevel() {
  const timeSinceFlush = Date.now() - lastFlushTime;
  if (timeSinceFlush === 0) return 'low';
  
  const requestsPerMinute = localStats.requests / (timeSinceFlush / 60000);
  
  if (requestsPerMinute > 50) return 'high';
  if (requestsPerMinute > 10) return 'medium';
  return 'low';
}

function getFlushThresholds(trafficLevel) {
  if (trafficLevel === 'high') {
    // High traffic: flush less frequently to conserve KV writes
    return { interval: 10 * 60 * 1000, threshold: 500 }; // 10min or 500 requests
  } else if (trafficLevel === 'medium') {
    return { interval: 5 * 60 * 1000, threshold: 200 }; // 5min or 200 requests
  } else {
    // Low traffic: flush more frequently for real-time stats
    return { interval: 2 * 60 * 1000, threshold: 50 }; // 2min or 50 requests
  }
}

async function updateStats(env, ctx, delta) {
  // Update local stats
  for (const key in delta) {
    localStats[key] = (localStats[key] || 0) + (delta[key] || 0);
  }
  
  // Safety cap to prevent memory issues
  if (localStats.requests > 10000) {
    console.warn("⚠️ Stats overflow! Force flushing...");
    await forceFlushStats(env);
    return;
  }

  const trafficLevel = detectTrafficLevel();
  const { interval, threshold } = getFlushThresholds(trafficLevel);
  const timeSinceFlush = Date.now() - lastFlushTime;
  
  const shouldFlush = timeSinceFlush >= interval || localStats.requests >= threshold;

  if (!shouldFlush || !env.KV_STATS || isFlushingKV) return;

  // Batch flush with retry logic
  isFlushingKV = true;
  ctx.waitUntil(
    (async () => {
      try {
        const kvData = await env.KV_STATS.get("stats", { type: "json" });
        const merged = kvData || {
          requests: 0,
          cacheHits: 0,
          cacheMisses: 0,
          bytesSaved: 0,
          compressed: 0,
          directFetch: 0,
          errors: 0,
          lastReset: new Date().toISOString(),
        };

        for (const key in localStats) {
          merged[key] = (merged[key] || 0) + localStats[key];
        }
        
        merged.lastUpdate = new Date().toISOString();
        merged.trafficLevel = trafficLevel;

        await env.KV_STATS.put("stats", JSON.stringify(merged));
        
        console.log(`💾 KV flushed: ${localStats.requests} requests (${trafficLevel} traffic)`);

        // Reset local stats
        localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, compressed: 0, directFetch: 0, errors: 0 };
        lastFlushTime = Date.now();
        flushFailureCount = 0;
        
      } catch (err) {
        flushFailureCount++;
        console.error(`❌ KV flush failed (${flushFailureCount} times):`, err.message);
        
        // If flush keeps failing, force reset to prevent memory bloat
        if (flushFailureCount >= 5) {
          console.warn("⚠️ Too many flush failures, resetting local stats");
          localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, compressed: 0, directFetch: 0, errors: 0 };
          lastFlushTime = Date.now();
          flushFailureCount = 0;
        }
      } finally {
        isFlushingKV = false;
      }
    })()
  );
}

async function forceFlushStats(env) {
  if (!env.KV_STATS || isFlushingKV) return;
  
  isFlushingKV = true;
  try {
    const kvData = await env.KV_STATS.get("stats", { type: "json" });
    const merged = kvData || { 
      requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, 
      compressed: 0, directFetch: 0, errors: 0, 
      lastReset: new Date().toISOString() 
    };
    
    for (const key in localStats) {
      merged[key] = (merged[key] || 0) + localStats[key];
    }
    
    await env.KV_STATS.put("stats", JSON.stringify(merged));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, compressed: 0, directFetch: 0, errors: 0 };
    lastFlushTime = Date.now();
  } finally {
    isFlushingKV = false;
  }
}

// =================== PREFETCH ENDPOINT ===================

async function handlePrefetch(request, env, ctx) {
  if (request.method !== "POST") {
    return errorResponse("POST method required", 405);
  }

  try {
    const body = await request.json();
    const { urls, quality = 75, jpeg = false } = body;
    
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 20) {
      return errorResponse("Invalid urls array (1-20 URLs required)", 400);
    }
    
    console.log(`🔥 Prefetching ${urls.length} images`);
    
    // Process prefetch in background
    ctx.waitUntil(
      (async () => {
        for (const targetUrl of urls) {
          try {
            if (!isValidImageUrl(targetUrl)) {
              console.warn("⚠️ Invalid prefetch URL, skipping");
              continue;
            }

            const wsrvParams = new URLSearchParams({
              url: targetUrl,
              q: quality.toString(),
              output: jpeg ? "jpg" : "webp",
              default: "1",
              n: "-1",
            });
            
            const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
            const format = jpeg ? "jpg" : "webp";
            const cacheKey = new Request(`v2-${btoa(targetUrl).slice(0, 50)}-q${quality}-${format}-c`);
            const cache = caches.default;
            
            // Check if already cached
            const cached = await cache.match(cacheKey);
            if (cached) {
              console.log("✅ Prefetch: Already cached");
              continue;
            }
            
            // Fetch and cache
            const response = await fetch(wsrvUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Linux; Android 14) Chrome/125",
                "Accept": "image/*",
              },
              cf: { cacheEverything: true, cacheTtl: 604800 },
            });
            
            if (response.ok) {
              await cache.put(cacheKey, response.clone());
              console.log("✅ Prefetch: Cached successfully");
            }
            
            // Small delay to avoid overwhelming wsrv.nl
            await new Promise(resolve => setTimeout(resolve, 100));
            
          } catch (err) {
            console.error("❌ Prefetch error:", err.message);
          }
        }
      })()
    );
    
    return new Response(JSON.stringify({ 
      status: "prefetching", 
      count: urls.length,
      message: "Images are being cached in background"
    }), {
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err) {
    return errorResponse("Invalid JSON body", 400);
  }
}

// =================== DISPLAY ENDPOINTS ===================

function healthCheck(env) {
  return new Response(JSON.stringify({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    kvAvailable: !!env.KV_STATS,
    pendingFlush: localStats.requests,
    queueStats: wsrvQueue.getStats(),
    trafficLevel: detectTrafficLevel(),
    version: "3.0"
  }), {
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

async function showStatsJSON(env) {
  if (!env.KV_STATS) {
    return errorResponse("KV_STATS not configured", 500);
  }

  const stats = await env.KV_STATS.get("stats", { type: "json" });
  const data = stats || { 
    requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, 
    compressed: 0, directFetch: 0, errors: 0 
  };
  
  const total = data.requests || 1;
  const enriched = {
    ...data,
    cacheHitRate: safePercent(data.cacheHits, total) + "%",
    compressionRate: safePercent(data.compressed, total) + "%",
    successRate: safePercent((data.compressed || 0) + (data.directFetch || 0), total) + "%",
    successRate: (((data.compressed + data.directFetch) / total) * 100).toFixed(1) + "%",
    bytesSavedMB: (data.bytesSaved / (1024 * 1024)).toFixed(2) + " MB",
    bytesSavedGB: (data.bytesSaved / (1024 * 1024 * 1024)).toFixed(3) + " GB",
    pendingFlush: localStats,
    queueStats: wsrvQueue.getStats(),
    version: "3.0"
  };

  return new Response(JSON.stringify(enriched, null, 2), {
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    }
  });
}

async function showStatsPage(env) {
  if (!env.KV_STATS) {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h1>⚠️ KV_STATS Not Configured</h1>
        <p>Add KV namespace binding in wrangler.toml</p>
      </body></html>`,
      { status: 500, headers: { "Content-Type": "text/html" } }
    );
  }

  const stats = await env.KV_STATS.get("stats", { type: "json" });
  const data = stats || { 
    requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, 
    compressed: 0, directFetch: 0, errors: 0, lastReset: "N/A" 
  };
  
  const total = data.requests || 1;
function safePercent(num, den) {
  if (!num || !den || den === 0 || isNaN(num) || isNaN(den)) return 0;
  return ((num / den) * 100).toFixed(1);
}

  const hitRate = safePercent(data.cacheHits, total);
  const compressionRate = safePercent(data.compressed, total);
  const successRate = safePercent((data.compressed || 0) + (data.directFetch || 0), total);
  const savedMB = (data.bytesSaved / (1024 * 1024)).toFixed(2);
  const savedGB = (data.bytesSaved / (1024 * 1024 * 1024)).toFixed(3);
  const queueStats = wsrvQueue.getStats();

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>📊 Bandwidth Hero Statistics</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 {
      color: #667eea;
      margin-bottom: 10px;
      font-size: 2.5em;
      text-align: center;
    }
    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 30px;
      font-size: 1.1em;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin: 30px 0;
    }
    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 15px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
      transition: transform 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 15px 40px rgba(102, 126, 234, 0.4);
    }
    .stat-number {
      font-size: 3em;
      font-weight: bold;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }
    .stat-label {
      font-size: 1.1em;
      opacity: 0.95;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .stat-sublabel {
      font-size: 0.9em;
      opacity: 0.8;
      margin-top: 5px;
    }
    .green { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
    .blue { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); }
    .orange { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
    .red { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
    .section {
      background: #f8f9fa;
      padding: 25px;
      border-radius: 15px;
      margin: 25px 0;
    }
    .section h2 {
      color: #333;
      margin-bottom: 15px;
      font-size: 1.5em;
    }
    .progress-bar {
      background: #e0e0e0;
      border-radius: 10px;
      height: 25px;
      margin: 15px 0;
      overflow: hidden;
    }
    .progress-fill {
      background: linear-gradient(90deg, #10b981 0%, #059669 100%);
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: bold;
      transition: width 0.3s;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid #e0e0e0;
    }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-weight: 600; color: #555; }
    .info-value { color: #667eea; font-weight: bold; }
    .button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 15px 30px;
      border-radius: 10px;
      text-decoration: none;
      font-weight: bold;
      margin: 10px 5px;
      transition: transform 0.2s;
    }
    .button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
    }
    .button.danger {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
    }
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: 1fr; }
      h1 { font-size: 2em; }
      .container { padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Bandwidth Hero Stats</h1>
    <p class="subtitle">🚀 Production Ready v3.0 • Dedup + Queue + Adaptive KV</p>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-number">${data.requests.toLocaleString()}</div>
        <div class="stat-label">Total Requests</div>
      </div>
      
      <div class="stat-card green">
        <div class="stat-number">${savedGB} GB</div>
        <div class="stat-label">Bandwidth Saved</div>
        <div class="stat-sublabel">${savedMB} MB</div>
      </div>
      
      <div class="stat-card blue">
        <div class="stat-number">${hitRate}%</div>
        <div class="stat-label">Cache Hit Rate</div>
        <div class="stat-sublabel">${data.cacheHits.toLocaleString()} / ${data.requests.toLocaleString()}</div>
      </div>
      
      <div class="stat-card">
        <div class="stat-number">${data.compressed.toLocaleString()}</div>
        <div class="stat-label">Compressed</div>
        <div class="stat-sublabel">${compressionRate}% via wsrv.nl</div>
      </div>
      
      <div class="stat-card">
        <div class="stat-number">${data.directFetch.toLocaleString()}</div>
        <div class="stat-label">Direct Fetch</div>
        <div class="stat-sublabel">Fallback mode</div>
      </div>
      
      <div class="stat-card orange">
        <div class="stat-number">${data.errors.toLocaleString()}</div>
        <div class="stat-label">Errors</div>
        <div class="stat-sublabel">Failed requests</div>
      </div>
    </div>
    
    <div class="section">
      <h2>📈 Performance Metrics</h2>
      
      <div class="info-row">
        <span class="info-label">Cache Hit Rate</span>
        <span class="info-value">${hitRate}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${hitRate}%">${hitRate}%</div>
      </div>
      
      <div class="info-row" style="margin-top: 20px;">
        <span class="info-label">Compression Rate</span>
        <span class="info-value">${compressionRate}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${compressionRate}%">${compressionRate}%</div>
      </div>
      
      <div class="info-row" style="margin-top: 20px;">
        <span class="info-label">Success Rate</span>
        <span class="info-value">${successRate}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${successRate}%">${successRate}%</div>
      </div>
    </div>
    
    <div class="section">
      <h2>🚦 Queue Status (Real-time)</h2>
      <div class="info-row">
        <span class="info-label">Active Requests</span>
        <span class="info-value">${queueStats.active} / 10</span>
      </div>
      <div class="info-row">
        <span class="info-label">Queued Requests</span>
        <span class="info-value">${queueStats.queued}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Requests/Min</span>
        <span class="info-value">${queueStats.requestsLastMinute} / 60</span>
      </div>
      <div class="info-row">
        <span class="info-label">Traffic Level</span>
        <span class="info-value">${data.trafficLevel || 'N/A'}</span>
      </div>
    </div>
    
    <div class="section">
      <h2>ℹ️ System Info</h2>
      <div class="info-row">
        <span class="info-label">Stats Since</span>
        <span class="info-value">${data.lastReset}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Last Update</span>
        <span class="info-value">${data.lastUpdate || 'N/A'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">KV Flush Strategy</span>
        <span class="info-value">Adaptive (2-10min)</span>
      </div>
      <div class="info-row">
        <span class="info-label">Pending Flush</span>
        <span class="info-value">${localStats.requests} requests</span>
      </div>
      <div class="info-row">
        <span class="info-label">Version</span>
        <span class="info-value">v3.0 Production</span>
      </div>
    </div>
    
    <center>
      <a href="/" class="button">← Home</a>
      <a href="/stats" class="button">🔄 Refresh</a>
      <a href="/stats.json" class="button">📄 JSON API</a>
      <a href="/health" class="button">💚 Health Check</a>
      <a href="/reset" class="button danger" onclick="return confirm('Reset all statistics?');">🗑️ Reset Stats</a>
    </center>
  </div>
  
  <script>
    // Auto-refresh every 10 seconds
    setTimeout(() => location.reload(), 10000);
  </script>
</body>
</html>`,
    { headers: { 
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache"
    }}
  );
}

function getWebInterface() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>⚡ Bandwidth Hero Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      padding: 40px;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 600px;
      text-align: center;
    }
    h1 { 
      color: #667eea; 
      margin-bottom: 20px; 
      font-size: 2.5em; 
    }
    p { 
      color: #666; 
      line-height: 1.8; 
      margin: 15px 0; 
    }
    code {
      background: #f1f5f9;
      padding: 4px 10px;
      border-radius: 5px;
      color: #d63384;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
    }
    .feature {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 10px;
      margin: 15px 0;
      text-align: left;
    }
    .feature::before {
      content: "✓ ";
      color: #10b981;
      font-weight: bold;
      font-size: 1.2em;
    }
    .button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 15px 30px;
      border-radius: 10px;
      text-decoration: none;
      font-weight: bold;
      margin: 10px 5px;
      transition: transform 0.2s;
    }
    .button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
    }
    .usage-box {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 10px;
      margin: 20px 0;
      text-align: left;
    }
    .usage-box h3 {
      color: #333;
      margin-bottom: 10px;
    }
    @media (max-width: 768px) {
      h1 { font-size: 2em; }
      .card { padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ Bandwidth Hero Proxy</h1>
    <p>Production-ready image compression for Tachiyomi & Bandwidth Hero</p>
    
    <div class="feature">Request deduplication (prevents cache stampede)</div>
    <div class="feature">Rate limit handling with exponential backoff</div>
    <div class="feature">Request queue (max 10 concurrent, 60/min)</div>
    <div class="feature">Adaptive KV flushing based on traffic</div>
    <div class="feature">WebP compression (~50-70% bandwidth savings)</div>
    <div class="feature">Multi-UA fallback for blocked origins</div>
    <div class="feature">Perfect for 200+ page manhwa reading</div>
    
    <div class="usage-box">
      <h3>📖 Usage</h3>
      <p><strong>Image Proxy:</strong></p>
      <p><code>?url=IMAGE_URL&l=75&jpg=0&bw=0</code></p>
      <p style="margin-top: 10px;"><strong>Prefetch API (POST):</strong></p>
      <p><code>/prefetch</code></p>
      <p style="font-size: 0.9em; color: #666; margin-top: 5px;">
        Body: <code>{"urls": ["url1", "url2"], "quality": 75}</code>
      </p>
    </div>
    
    <div class="usage-box">
      <h3>🎯 Parameters</h3>
      <p><code>url</code> - Image URL (required)</p>
      <p><code>l</code> - Quality 1-100 (default: 75)</p>
      <p><code>jpg=1</code> - Force JPEG (default: WebP)</p>
      <p><code>bw=1</code> - Black & white</p>
      <p><code>debug=1</code> - Skip cache</p>
    </div>
    
    <div style="margin-top: 30px;">
      <a href="/stats" class="button">📊 View Statistics</a>
      <a href="/stats.json" class="button">📄 JSON API</a>
      <a href="/health" class="button">💚 Health Check</a>
    </div>
    
    <p style="margin-top: 30px; font-size: 0.9em; color: #999;">
      Version 3.0 • Built for Cloudflare Workers Free Tier
    </p>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// =================== UTILITY FUNCTIONS ===================

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function errorResponse(msg, status = 500) {
  // Sanitize error messages to prevent URL leakage
  const sanitized = msg.replace(/https?:\/\/[^\s]+/g, '[URL]');
  
  return new Response(JSON.stringify({ 
    error: sanitized, 
    status,
    timestamp: new Date().toISOString()
  }), {
    status,
    headers: { 
      "Content-Type": "application/json", 
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    },
  });
}

function addHeaders(response, startTime, cacheStatus, quality, compressionRatio = "N/A") {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "*");
  headers.set("Cache-Control", "public, max-age=604800, stale-while-revalidate=2592000");
  headers.set("CDN-Cache-Control", "public, max-age=31536000");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality.toString());
  headers.set("X-Compression-Ratio", compressionRatio);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Powered-By", "Bandwidth-Hero-Worker-v3.0");
  headers.delete("Content-Security-Policy");
  headers.delete("X-Frame-Options");
  
  return new Response(response.body, { 
    status: response.status, 
    statusText: response.statusText,
    headers 
  });
}

