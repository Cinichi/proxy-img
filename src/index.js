// 🚀 Bandwidth Hero Cloudflare Worker v4.5
// ✅ Multiple compression proxies (wsrv.nl + images.weserv.nl)
// ✅ Auto mask when direct proxy fails
// ✅ Full referer fix for manga sites
// ✅ Compression + Cache + KV stats

// =================== CONFIG ===================
const MASK_PROXY = "https://proxy-img.zoro1.workers.dev/"; // 👈 your 2nd CF image proxy

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// =================== REFERER LOGIC ===================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // 🔹 Mangabuddy numbered CDNs
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    if (match) {
      return `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`;
    }
    return "https://mangabuddy.com/";
  }

  // 🔹 Mangabuddy backup CDN
  if (host.includes("mgcdn.xyz") || host.includes("mbbcdn.com"))
    return "https://res.mgcdn.xyz/";

  // 🔹 Mangapill / Conan
  if (host.includes("readdetectiveconan.com") || host.includes("mangapill.com"))
    return "https://mangapill.com/";

  // 🔹 Hentaifox
  if (host.includes("hentaifox.com")) return "https://hentaifox.com/";

  // 🔹 NHentai
  if (host.includes("nhentai.net")) return "https://nhentai.net/";

  return `https://${hostname}/`;
}

// =================== WORKER ENTRY ===================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleCORS();
    
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ 
        status: "ok", 
        timestamp: new Date().toISOString() 
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    if (url.pathname === "/stats") return await showStatsPage(env);
    
    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset.", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (!url.searchParams.get("url")) return getWebInterface();

    try {
      return await handleImageRequest(request, env, ctx);
    } catch (err) {
      console.error("❌ Worker error:", err);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// =================== IMAGE LOGIC ===================
async function handleImageRequest(request, env, ctx) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const debug = url.searchParams.get("debug") === "1";

  // 🔹 MASK MODE: Just fetch the raw image (used by wsrv.nl)
  if (url.searchParams.get("mask") === "1") {
    if (debug) console.log("🎭 MASK MODE: Fetching raw image");
    return await fetchDirectImage(targetUrl, debug);
  }

  const bw = url.searchParams.get("bw") === "1";
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));

  const parsedTarget = new URL(targetUrl);
  const referer = getRefererForHost(parsedTarget.hostname, targetUrl);
  const cache = caches.default;

  const cacheKey = new Request(
    `${targetUrl}##q${quality}-${jpeg ? "jpg" : "webp"}-${bw ? "bw" : "color"}`
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    if (debug) console.log("✅ CACHE HIT");
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT", quality);
  }

  if (debug) console.log(`📥 Fetching ${parsedTarget.hostname} | q=${quality}`);

  // =================== COMPRESSION STRATEGY ===================
  // Try multiple proxies in order, then fallback to direct fetch

  const proxies = [
    { name: "images.weserv.nl", url: "https://images.weserv.nl/" },
    { name: "wsrv.nl", url: "https://wsrv.nl/" }
  ];

  let response = null;
  let usedMethod = "none";

  // 🟢 Attempt 1: Try compression proxies directly
  for (const proxy of proxies) {
    const proxyParams = new URLSearchParams({
      url: targetUrl,
      q: quality.toString(),
      output: jpeg ? "jpg" : "webp",
    });
    if (bw) proxyParams.set("il", "");
    
    const proxyUrl = `${proxy.url}?${proxyParams.toString()}`;
    
    if (debug) console.log(`🔵 Trying ${proxy.name}...`);
    
    try {
      const fetchResponse = await fetch(proxyUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36",
          "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });

      if (fetchResponse.ok && (fetchResponse.headers.get("content-type") || "").includes("image/")) {
        response = fetchResponse;
        usedMethod = proxy.name;
        if (debug) console.log(`✅ ${proxy.name} SUCCESS`);
        break;
      } else {
        if (debug) console.log(`❌ ${proxy.name} failed: ${fetchResponse.status}`);
      }
    } catch (err) {
      if (debug) console.log(`❌ ${proxy.name} error:`, err.message);
    }
  }

  // 🟡 Attempt 2: Try masked compression (proxy fetches from mask proxy)
  if (!response) {
    if (debug) console.log("🟡 Direct proxies failed, trying MASKED compression...");
    
    for (const proxy of proxies) {
      const maskedSource = `${MASK_PROXY}?url=${encodeURIComponent(targetUrl)}&mask=1`;
      const maskedParams = new URLSearchParams({
        url: maskedSource,
        q: quality.toString(),
        output: jpeg ? "jpg" : "webp",
      });
      if (bw) maskedParams.set("il", "");
      
      const maskedUrl = `${proxy.url}?${maskedParams.toString()}`;
      
      if (debug) console.log(`🔁 Trying masked ${proxy.name}...`);
      
      try {
        const fetchResponse = await fetch(maskedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
          },
          cf: { cacheEverything: true, cacheTtl: 604800 },
        });

        if (fetchResponse.ok && (fetchResponse.headers.get("content-type") || "").includes("image/")) {
          response = fetchResponse;
          usedMethod = `masked-${proxy.name}`;
          if (debug) console.log(`✅ Masked ${proxy.name} SUCCESS`);
          break;
        } else {
          if (debug) console.log(`❌ Masked ${proxy.name} failed: ${fetchResponse.status}`);
        }
      } catch (err) {
        if (debug) console.log(`❌ Masked ${proxy.name} error:`, err.message);
      }
    }
  }

  // 🔴 Attempt 3: Direct fetch (no compression)
  if (!response) {
    if (debug) console.log("🔴 All compression failed, trying direct fetch...");
    usedMethod = "direct";
    response = await fetchDirectImage(targetUrl, debug);
  }

  // Final validation
  if (!response || !response.ok) {
    console.error(`❌ ALL ATTEMPTS FAILED for ${targetUrl}`);
    return errorResponse(`Failed to fetch image (status: ${response?.status || "unknown"})`, response?.status || 502);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("image/")) {
    console.error(`❌ Invalid content-type: ${contentType}`);
    return errorResponse("Not an image", 502);
  }

  // Calculate bytes saved
  const contentLength = parseInt(response.headers.get("content-length") || "0");
  const estimatedOriginal = Math.round(contentLength * 1.7);
  const bytesSaved = usedMethod !== "direct" ? Math.max(0, estimatedOriginal - contentLength) : 0;
  
  if (bytesSaved > 0) {
    localStats.bytesSaved += bytesSaved;
  }

  if (debug) console.log(`💾 Method: ${usedMethod} | Size: ${contentLength} | Saved: ${bytesSaved}`);

  // Cache and update stats
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, startTime, `MISS-${usedMethod}`, quality);
}

// =================== DIRECT FETCH ===================
async function fetchDirectImage(targetUrl, debug = false) {
  try {
    const parsed = new URL(targetUrl);
    const referer = getRefererForHost(parsed.hostname, targetUrl);
    
    if (debug) console.log(`🎭 Direct fetch | Referer: ${referer}`);
    
    const response = await fetch(targetUrl, {
      headers: {
        Referer: referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });
    
    return response;
  } catch (err) {
    console.error("❌ Direct fetch error:", err);
    return new Response("Direct fetch failed", { status: 502 });
  }
}

// =================== HELPERS ===================
function addHeaders(response, startTime, cacheStatus, quality) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status,X-Quality,X-Response-Time");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality.toString());
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  return new Response(response.body, { status: response.status, headers });
}

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
  return new Response(
    JSON.stringify({ 
      error: msg, 
      status, 
      timestamp: new Date().toISOString() 
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    }
  );
}

// =================== STATS & UI ===================
async function updateStats(env, delta) {
  for (const key in delta) {
    localStats[key] = (localStats[key] || 0) + (delta[key] || 0);
  }
  
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;

  try {
    const kvData = (await env.KV_STATS.get("stats", { type: "json" })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: new Date().toISOString(),
    };
    
    for (const key in localStats) {
      kvData[key] = (kvData[key] || 0) + localStats[key];
    }
    
    await env.KV_STATS.put("stats", JSON.stringify(kvData));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    console.error("❌ KV update failed:", err);
  }
}

async function showStatsPage(env) {
  const stats = (await env.KV_STATS.get("stats", { type: "json" })) || {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesSaved: 0,
    lastReset: "N/A",
  };
  
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate = stats.requests > 0 
    ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) 
    : 0;
    
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>📊 Bandwidth Hero Stats</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 40px; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; }
    .stat { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee; }
    .stat:last-child { border-bottom: none; }
    .label { color: #666; }
    .value { font-weight: 600; color: #0066cc; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Bandwidth Hero v4.5</h1>
    <div class="stat"><span class="label">Total Requests:</span><span class="value">${stats.requests}</span></div>
    <div class="stat"><span class="label">Cache Hits:</span><span class="value">${stats.cacheHits} (${hitRate}%)</span></div>
    <div class="stat"><span class="label">Cache Misses:</span><span class="value">${stats.cacheMisses}</span></div>
    <div class="stat"><span class="label">Data Saved:</span><span class="value">${savedMB} MB</span></div>
    <div class="stat"><span class="label">Last Reset:</span><span class="value">${stats.lastReset}</span></div>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function getWebInterface() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚡ Bandwidth Hero Proxy</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 40px; background: #f5f5f5; }
    .container { max-width: 700px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h2 { color: #333; margin-bottom: 20px; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 14px; }
    .usage { background: #f9f9f9; padding: 15px; border-radius: 4px; margin: 20px 0; }
    ul { line-height: 1.8; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h2>⚡ Bandwidth Hero Proxy v4.5</h2>
    <div class="usage">
      <p><strong>Usage:</strong></p>
      <p><code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0&debug=0</code></p>
      <p><strong>Parameters:</strong></p>
      <ul>
        <li><code>url</code> - Image URL (required)</li>
        <li><code>l</code> - Quality 1-100 (default: 75)</li>
        <li><code>jpg</code> - Force JPEG instead of WebP</li>
        <li><code>bw</code> - Black & white mode</li>
        <li><code>debug</code> - Enable debug logging</li>
      </ul>
    </div>
    <p><strong>Features:</strong></p>
    <ul>
      <li>✅ Dual compression proxy (images.weserv.nl + wsrv.nl)</li>
      <li>✅ Auto referer for manga sites (Mangabuddy, Mangapill, etc)</li>
      <li>✅ Masked compression for protected images</li>
      <li>✅ Smart caching & stats tracking</li>
    </ul>
    <p><strong>Links:</strong></p>
    <p>📊 <a href="/stats">Statistics</a> | 🔄 <a href="/reset">Reset Stats</a> | 💚 <a href="/health">Health Check</a></p>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
