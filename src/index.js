// 🚀 Bandwidth Hero Cloudflare Worker v4.8
// ✅ Fixed: "libvips error: webpsave: image too large"
// ✅ Auto JPEG fallback for tall manhwa strips
// ✅ Auto referer for Mangabuddy, Mangapill, NHentai, Hentaifox
// ✅ Works with Tachiyomi + Bandwidth Hero
// ✅ Masked + direct fallback

const MASK_PROXY = "https://proxy-img.zoro1.workers.dev/";
const CACHE_TTL = 604800; // 7 days
const STATS_FLUSH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const DEFAULT_QUALITY = 100;

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

const PROXIES = [
  { name: "images.weserv.nl", url: "https://images.weserv.nl/" },
  { name: "wsrv.nl", url: "https://wsrv.nl/" },
];

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="134", "Google Chrome";v="134"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
};

// =================== REFERER LOGIC ===================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // Mangabuddy CDN with chapter auto-detect
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    return match 
      ? `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`
      : "https://mangabuddy.com/";
  }

  // Likemanga CDN
  if (host.includes("likemanga") || host.includes("1kmgv")) {
    return "https://likemanga.ink/";
  }

  // Other CDNs
  const refererMap = {
    mgcdn: "https://res.mgcdn.xyz/",
    mbbcdn: "https://res.mgcdn.xyz/",
    mangapill: "https://mangapill.com/",
    readdetectiveconan: "https://mangapill.com/",
    hentaifox: "https://hentaifox.com/",
    nhentai: "https://nhentai.net/",
  };

  for (const [key, referer] of Object.entries(refererMap)) {
    if (host.includes(key)) return referer;
  }

  return `https://${hostname}/`;
}

// =================== WORKER ENTRY ===================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (request.method === "OPTIONS") return handleCORS();

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", time: new Date().toISOString() }), 
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Stats page
    if (url.pathname === "/stats") return showStatsPage(env);

    // Reset stats
    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset.", { 
        headers: { "Content-Type": "text/plain" } 
      });
    }

    // Web interface
    if (!url.searchParams.get("url")) return getWebInterface();

    // Handle image request
    try {
      return await handleImageRequest(request, env, ctx);
    } catch (err) {
      console.error("❌ Worker error:", err);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// =================== IMAGE HANDLER ===================
async function handleImageRequest(request, env, ctx) {
  const start = Date.now();
  const url = new URL(request.url);
  
  // Parse parameters
  const targetUrl = url.searchParams.get("url");
  const debug = url.searchParams.get("debug") === "1";
  const bw = url.searchParams.get("bw") === "1";
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || DEFAULT_QUALITY));

  const parsed = new URL(targetUrl);
  const referer = getRefererForHost(parsed.hostname, targetUrl);
  
  // Cache handling
  const cache = caches.default;
  const cacheKey = new Request(
    `${targetUrl}##q${quality}-${jpeg ? "jpg" : "webp"}-${bw ? "bw" : "clr"}`
  );
  
  const cached = await cache.match(cacheKey);
  if (cached) {
    if (debug) console.log("✅ Cache hit");
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, start, "HIT", quality);
  }

  if (debug) console.log(`📥 Fetching ${parsed.hostname} | Referer: ${referer}`);

  // Try compression proxies
  let response = await tryCompressionProxies(targetUrl, referer, quality, jpeg, bw, debug);
  let usedMethod = response?.method || "none";

  // Fallback to direct fetch
  if (!response?.ok) {
    if (debug) console.log("🔴 All compression failed — trying direct fetch");
    response = await fetchDirectImage(targetUrl, referer, debug);
    usedMethod = "direct";
  }

  // Final validation
  if (!response?.ok || !isImageResponse(response)) {
    console.error(`❌ Failed (${response?.status}) ${targetUrl}`);
    return errorResponse(`Failed (${response?.status || "unknown"})`, response?.status || 502);
  }

  // Track bandwidth savings
  const len = parseInt(response.headers.get("content-length") || "0");
  if (usedMethod !== "direct" && len > 0) {
    const saved = Math.round(len * 0.4); // Estimate 40% savings
    localStats.bytesSaved += saved;
  }

  // Cache successful response
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, start, `MISS-${usedMethod}`, quality);
}

// =================== COMPRESSION PROXIES ===================
async function tryCompressionProxies(targetUrl, referer, quality, jpeg, bw, debug) {
  for (const proxy of PROXIES) {
    const format = jpeg ? "jpg" : "webp";
    const wsrvUrl = `${proxy.url}?url=${encodeURIComponent(targetUrl)}&q=${quality}&output=${format}${bw ? "&il" : ""}`;

    if (debug) console.log(`🔵 Trying ${proxy.name}`);

    try {
      const response = await fetch(wsrvUrl, {
        headers: { ...BROWSER_HEADERS, Referer: referer },
        cf: { cacheEverything: true, cacheTtl: CACHE_TTL },
      });

      // Check if valid image
      if (isImageResponse(response)) {
        if (debug) console.log(`✅ ${proxy.name} success`);
        response.method = proxy.name;
        return response;
      }

      // Check for "image too large" error
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json") || contentType.includes("text/html")) {
        const errorText = await response.text();
        
        if (errorText.includes("image too large") && !jpeg) {
          if (debug) console.log(`🟠 ${proxy.name}: image too large, retrying as JPEG`);
          
          // Retry with JPEG
          const retryUrl = `${proxy.url}?url=${encodeURIComponent(targetUrl)}&q=${quality}&output=jpg`;
          const retry = await fetch(retryUrl, {
            headers: { ...BROWSER_HEADERS, Referer: referer },
            cf: { cacheEverything: true, cacheTtl: CACHE_TTL },
          });

          if (isImageResponse(retry)) {
            if (debug) console.log(`✅ ${proxy.name} JPEG fallback success`);
            retry.method = `${proxy.name}-jpeg`;
            return retry;
          }
        }
      }

      if (debug) console.log(`❌ ${proxy.name} failed: ${response.status}`);
    } catch (err) {
      if (debug) console.log(`❌ ${proxy.name} error: ${err.message}`);
    }
  }

  return null;
}

// =================== DIRECT FETCH ===================
async function fetchDirectImage(targetUrl, referer, debug = false) {
  const fallbackReferers = [
    referer,
    "https://likemanga.ink/",
    "https://mangabuddy.com/",
    "https://manganato.com/",
  ];

  for (const ref of fallbackReferers) {
    if (debug) console.log(`🎯 Direct fetch with referer: ${ref}`);
    
    try {
      const response = await fetch(targetUrl, {
        headers: { ...BROWSER_HEADERS, Referer: ref },
        cf: { cacheEverything: true, cacheTtl: CACHE_TTL },
      });

      if (isImageResponse(response)) {
        if (debug) console.log(`✅ Direct fetch success with: ${ref}`);
        return response;
      }
    } catch (err) {
      if (debug) console.log(`❌ Direct fetch failed with ${ref}: ${err.message}`);
    }
  }

  return new Response("All fetch attempts failed", { status: 502 });
}

// =================== HELPERS ===================
function isImageResponse(response) {
  if (!response?.ok) return false;
  const contentType = response.headers.get("content-type") || "";
  return contentType.startsWith("image/");
}

function addHeaders(response, start, cacheStatus, quality) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality.toString());
  headers.set("X-Response-Time", `${Date.now() - start}ms`);
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
    JSON.stringify({ error: msg, status, time: new Date().toISOString() }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// =================== STATS & UI ===================
async function updateStats(env, delta) {
  // Update local stats
  for (const k in delta) {
    localStats[k] = (localStats[k] || 0) + (delta[k] || 0);
  }
  
  // Flush to KV periodically
  if (Date.now() - lastFlushTime < STATS_FLUSH_INTERVAL) return;

  try {
    const kv = (await env.KV_STATS.get("stats", { type: "json" })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: new Date().toISOString(),
    };
    
    for (const k in localStats) {
      kv[k] = (kv[k] || 0) + localStats[k];
    }
    
    await env.KV_STATS.put("stats", JSON.stringify(kv));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    console.error("❌ KV update failed:", err.message);
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
  const mb = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hit = stats.requests
    ? ((stats.cacheHits / stats.requests) * 100).toFixed(1)
    : 0;
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h1>📊 Bandwidth Hero v4.8</h1>
<p>Total Requests: ${stats.requests}</p>
<p>Cache Hits: ${stats.cacheHits} (${hit}%)</p>
<p>Cache Misses: ${stats.cacheMisses}</p>
<p>Data Saved: ${mb} MB</p>
<p>Last Reset: ${stats.lastReset}</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

function getWebInterface() {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h2>⚡ Bandwidth Hero Proxy v4.8</h2>
<p>Usage: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
<ul>
<li>✅ Auto JPEG fallback (fix tall WebP crash)</li>
<li>✅ Mask + direct fallback</li>
<li>✅ Works with Tachiyomi, Bandwidth Hero</li>
<li>📊 <a href="/stats">Stats</a> | 💚 <a href="/health">Health</a></li>
</ul></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
