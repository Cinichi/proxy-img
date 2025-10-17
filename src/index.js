// 🚀 Bandwidth Hero Cloudflare Worker v1.3 (Tachiyomi Optimized + Live Stats)
// ✅ wsrv.nl compression
// ✅ Randomized User-Agent
// ✅ Cache HIT/MISS tracking
// ✅ Tachiyomi jpg/bw/l/debug parameters
// ✅ Live /stats endpoint
// ✅ Fallback system + CORS + Web Dashboard

// 🧠 Runtime stats (reset when Worker restarts)
const STATS = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
  lastReset: new Date().toISOString(),
};

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);
    STATS.requests++;

    // 🧭 /stats endpoint (JSON live data)
    if (url.pathname === "/stats") {
      const uptime = ((Date.now() - Date.parse(STATS.lastReset)) / 1000).toFixed(1);
      const savedMB = (STATS.bytesSaved / 1024 / 1024).toFixed(2);
      return new Response(JSON.stringify({
        status: "ok",
        uptime: `${uptime}s`,
        requests: STATS.requests,
        cacheHits: STATS.cacheHits,
        cacheMisses: STATS.cacheMisses,
        bytesSaved: STATS.bytesSaved,
        savedMB: `${savedMB} MB`,
        efficiency: STATS.requests > 0 ? `${((STATS.cacheHits / STATS.requests) * 100).toFixed(1)}%` : "0%",
        timestamp: new Date().toISOString(),
      }, null, 2), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 🧱 Handle CORS preflight
    if (request.method === "OPTIONS") return handleCORS();

    // Only allow GET/HEAD
    if (!["GET", "HEAD"].includes(request.method)) {
      return errorResponse("Method not allowed", 405);
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return getWebInterface();

    // ✅ Validate URL
    try {
      const parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol))
        return errorResponse("Invalid protocol (use http/https)", 400);
    } catch {
      return errorResponse("Invalid URL format", 400);
    }

    // ⚙️ Extract Tachiyomi/BandwidthHero parameters
    const bw = url.searchParams.get("bw") === "1" || url.searchParams.get("grayscale") === "1";
    const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
    const jpgParam = url.searchParams.get("jpg");
    const jpegParam = url.searchParams.get("jpeg");
    const jpeg = jpgParam === "1" || jpegParam === "1";
    const debug = url.searchParams.get("debug") === "1";

    console.log("📥 Incoming:", { url: targetUrl, quality, bw, jpeg, debug });

    try {
      return await handleCompressedImage(targetUrl, quality, bw, jpeg, startTime, ctx, debug);
    } catch (err) {
      console.error("❌ Worker Error:", err);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};
// 🧩 Compression via wsrv.nl
async function handleCompressedImage(targetUrl, quality, grayscale, jpeg, startTime, ctx, debug) {
  const wsrvParams = new URLSearchParams();
  wsrvParams.set("url", targetUrl);
  wsrvParams.set("q", quality.toString());
  wsrvParams.set("output", jpeg ? "jpg" : "webp");
  wsrvParams.set("default", "1");
  wsrvParams.set("n", "-1");
  if (grayscale) wsrvParams.set("il", "");

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
  const cache = caches.default;
  const cacheKey = new Request(`${wsrvUrl}-q${quality}-${jpeg ? "jpg" : "webp"}`);

  // 🧱 Cache check
  if (!debug) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      STATS.cacheHits++;
      console.log("✅ Cache HIT");
      return addHeaders(cached, startTime, "HIT-COMPRESSED", quality, wsrvUrl, debug);
    } else {
      STATS.cacheMisses++;
    }
  }

  // 🧠 Random UA rotation (avoid CDN blocks)
  const uaList = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/127 Mobile Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
  ];
  const browserUA = uaList[Math.floor(Math.random() * uaList.length)];

  console.log("❌ Cache MISS - Fetching from wsrv.nl...");
  const response = await fetch(wsrvUrl, {
    headers: {
      "User-Agent": browserUA,
      "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cf: { cacheEverything: true, cacheTtl: 604800, polish: "off" },
  });

  const contentType = response.headers.get("content-type") || "";
  const isImage = contentType.startsWith("image/");
  if (!response.ok || !isImage) {
    console.warn(`⚠️ wsrv.nl failed (${response.status}) — Fallback to direct`);
    return await handleDirectImage(targetUrl, browserUA, startTime, ctx, quality, debug);
  }

  // 💾 Compression stats
  const original = parseInt(response.headers.get("x-upstream-response-length") || "0");
  const compressed = parseInt(response.headers.get("content-length") || "0");
  if (original && compressed && compressed < original) {
    const saved = original - compressed;
    STATS.bytesSaved += saved;
    console.log(`💾 Saved ${saved} bytes (${((saved / original) * 100).toFixed(1)}%)`);
  }

  const clone = response.clone();
  ctx.waitUntil(cache.put(cacheKey, clone));
  return addHeaders(response, startTime, "MISS-COMPRESSED", quality, wsrvUrl, debug);
}

// 🧩 Direct fetch fallback
async function handleDirectImage(targetUrl, ua, startTime, ctx, quality, debug) {
  console.log("🔄 Direct fetch for:", targetUrl);
  const origin = new URL(targetUrl).origin;
  const cache = caches.default;
  const cacheKey = new Request(`direct-${targetUrl}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    STATS.cacheHits++;
    console.log("✅ Direct cache HIT");
    return addHeaders(cached, startTime, "HIT-DIRECT", quality);
  }

  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": ua,
      "Referer": origin + "/",
      "Accept": "image/webp,image/*,*/*;q=0.8",
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 604800,
      cacheTtlByStatus: { "200-299": 86400, "404": 60, "500-599": 30 },
      polish: "lossless",
    },
  });

  if (!response.ok) {
    console.error(`❌ Direct fetch failed: ${response.status}`);
    return errorResponse(`Direct fetch failed: ${response.status}`, response.status);
  }

  const clone = response.clone();
  ctx.waitUntil(cache.put(cacheKey, clone));
  return addHeaders(response, startTime, "MISS-DIRECT", quality);
}
function addHeaders(response, startTime, cacheStatus, quality = 0, wsrvUrl = "", debug = false, compressionRatio = "N/A") {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Quality", quality);
  headers.set("X-Powered-By", "Bandwidth-Hero-Worker");
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

// 🧩 HTML Dashboard with Live /stats
function getWebInterface() {
  return new Response(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>⚡ Bandwidth Hero Proxy v1.3</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);padding:20px;color:#111}
.container{background:#fff;border-radius:20px;max-width:900px;margin:0 auto;padding:30px;box-shadow:0 15px 40px rgba(0,0,0,.25)}
h1{color:#667eea;margin-bottom:10px}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}
.stat-card{display:inline-block;width:30%;text-align:center;margin:10px 1%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border-radius:10px;padding:20px}
.stat-num{font-size:2em;font-weight:bold}
a{color:#2563eb;text-decoration:none}
</style></head>
<body><div class="container">
<h1>⚡ Bandwidth Hero Proxy</h1>
<p>Optimized for Tachiyomi / BandwidthHero. Live metrics available below.</p>
<div id="stats"><p>Loading stats...</p></div>
<p>→ <a href="/stats" target="_blank">View raw JSON stats</a></p>
<script>
async function loadStats(){
  try{
    const res=await fetch('/stats');const s=await res.json();
    document.getElementById('stats').innerHTML=\`
      <div class="stat-card"><div class="stat-num">\${s.requests}</div><div>Requests</div></div>
      <div class="stat-card"><div class="stat-num">\${s.cacheHits}</div><div>Cache Hits</div></div>
      <div class="stat-card"><div class="stat-num">\${s.savedMB}</div><div>Saved (MB)</div></div>\`;
  }catch(e){document.getElementById('stats').innerHTML='<p>Error loading stats</p>';}
}
loadStats();setInterval(loadStats,5000);
</script>
</div></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}