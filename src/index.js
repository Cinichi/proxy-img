// ⚡ Bandwidth Hero Cloudflare Worker (with live stats & Tachiyomi support)
// Version: v2.1 – Full compression, caching, stats via KV

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    // Handle /stats
    const url = new URL(request.url);
    if (url.pathname === "/stats") {
      return await handleStats(env, url);
    }

    // Handle CORS
    if (request.method === "OPTIONS") return handleCORS();
    if (!["GET", "HEAD"].includes(request.method)) return errorResponse("Method not allowed", 405);

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return getWebInterface();

    // Validate URL
    try {
      const parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol))
        return errorResponse("Invalid URL protocol", 400);
    } catch {
      return errorResponse("Invalid URL format", 400);
    }

    // Parse Bandwidth Hero / Tachiyomi params
    const grayscale = url.searchParams.get("bw") === "1";
    const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
    const jpg = url.searchParams.get("jpg");
    const jpeg = url.searchParams.get("jpeg");
    const forceJpeg = jpg === "1" || jpeg === "1";
    const debug = url.searchParams.get("debug") === "1";

    try {
      const response = await handleCompressedImage(
        targetUrl,
        quality,
        grayscale,
        forceJpeg,
        startTime,
        ctx,
        debug
      );

      // ✅ Update stats immediately
      await updateStats(env, response);
      return response;
    } catch (err) {
      console.error("❌ Fatal error:", err.message);
      return errorResponse(`Internal error: ${err.message}`, 500);
    }
  },
};

// 🧠 Handle compression using wsrv.nl
async function handleCompressedImage(targetUrl, quality, grayscale, jpeg, startTime, ctx, debug) {
  const wsrvParams = new URLSearchParams({
    url: targetUrl,
    q: quality.toString(),
    output: jpeg ? "jpg" : "webp",
    default: "1",
    n: "-1",
  });
  if (grayscale) wsrvParams.set("il", "");

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams}`;
  const cacheKey = new Request(`${wsrvUrl}-q${quality}-${jpeg ? "jpg" : "webp"}`);
  const cache = caches.default;

  if (!debug) {
    const cached = await cache.match(cacheKey);
    if (cached)
      return addHeaders(cached, startTime, "HIT-COMPRESSED", quality, wsrvUrl, debug);
  }

  const ua =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Mobile Safari/537.36";

  const response = await fetch(wsrvUrl, {
    headers: {
      "User-Agent": ua,
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cf: { cacheEverything: true, cacheTtl: 604800, polish: "off" },
  });

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.startsWith("image/")) {
    console.warn("⚠️ wsrv.nl failed:", response.status, wsrvUrl);
    return await handleDirectImage(targetUrl, ua, startTime, ctx);
  }

  // Calculate compression ratio
  let compressionRatio = "N/A";
  const originalSize = response.headers.get("x-upstream-response-length");
  const compressedSize = response.headers.get("content-length");
  if (originalSize && compressedSize) {
    const saved = ((1 - parseInt(compressedSize) / parseInt(originalSize)) * 100).toFixed(1);
    compressionRatio = `${saved}%`;
  }

  const clone = response.clone();
  ctx.waitUntil(cache.put(cacheKey, clone));
  return addHeaders(response, startTime, "MISS-COMPRESSED", quality, wsrvUrl, debug, compressionRatio);
}

// 🔁 Fallback: direct fetch if wsrv.nl fails
async function handleDirectImage(targetUrl, ua, startTime, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`direct-${targetUrl}`);
  const cached = await cache.match(cacheKey);
  if (cached) return addHeaders(cached, startTime, "HIT-DIRECT", 100);

  const response = await fetch(targetUrl, {
    headers: { "User-Agent": ua, Referer: new URL(targetUrl).origin + "/" },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  if (!response.ok) return errorResponse(`Origin fetch failed ${response.status}`, response.status);

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return addHeaders(response, startTime, "MISS-DIRECT", 100);
}
// 🏷️ Add headers and metrics
function addHeaders(response, startTime, cacheStatus, quality, wsrvUrl, debug, compressionRatio = "N/A") {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  headers.set("Cache-Control", "public, max-age=604800");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Quality", quality.toString());
  headers.set("X-Compression-Ratio", compressionRatio);
  headers.set("X-Powered-By", "BandwidthHero-Worker");

  if (debug) headers.set("X-Debug-WSRV-URL", wsrvUrl);
  return new Response(response.body, { status: response.status, headers });
}

// ⚙️ Error handler
function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message, status }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

// 🧩 CORS preflight
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// 📊 Update stats in KV (immediate write)
async function updateStats(env, response) {
  try {
    let stats = await getFreshStats(env);
    stats.requests++;

    const cacheStatus = response.headers.get("X-Cache-Status") || "";
    if (cacheStatus.includes("HIT")) stats.cacheHits++;
    if (cacheStatus.includes("MISS")) stats.cacheMisses++;

    const saved = response.headers.get("X-Compression-Ratio");
    if (saved && saved.endsWith("%")) stats.bytesSaved += (parseFloat(saved) / 100) * 500000;

    await env.KV_STATS.put("stats", JSON.stringify(stats));
  } catch (err) {
    console.error("updateStats failed:", err);
  }
}

// 📦 Get stats from KV or initialize
async function getFreshStats(env) {
  const raw = await env.KV_STATS.get("stats", { type: "json", cacheTtl: 300 });
  if (raw) return raw;
  const init = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesSaved: 0,
    lastReset: new Date().toISOString(),
  };
  await env.KV_STATS.put("stats", JSON.stringify(init));
  return init;
}

// 📊 /stats page handler
async function handleStats(env, url) {
  const jsonMode = url.searchParams.get("json") === "1";
  const stats = await getFreshStats(env);

  if (jsonMode)
    return new Response(JSON.stringify(stats, null, 2), {
      headers: { "Content-Type": "application/json" },
    });

  const savedMB = (stats.bytesSaved / 1048576).toFixed(2);
  const hitRate =
    stats.requests > 0
      ? ((stats.cacheHits / stats.requests) * 100).toFixed(1)
      : 0;

  return new Response(
    `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>📊 Bandwidth Hero Worker Stats</title>
<style>
body{font-family:sans-serif;background:#f5f5f9;margin:0;padding:2em}
h1{color:#5c6bc0} .card{background:#fff;padding:20px;border-radius:12px;
box-shadow:0 3px 10px rgba(0,0,0,0.1);max-width:600px;margin:auto}
.stat{margin:10px 0;font-size:18px}
.bar{height:6px;border-radius:3px;background:#d1c4e9;margin:6px 0}
.fill{height:6px;border-radius:3px;background:#5c6bc0;width:${hitRate}%}
</style></head><body>
<div class="card"><h1>📊 Bandwidth Hero Worker Stats</h1>
<div class="stat">Total Requests: ${stats.requests}</div>
<div class="stat">Cache Hits: ${stats.cacheHits} (${hitRate}%)</div>
<div class="bar"><div class="fill"></div></div>
<div class="stat">Cache Misses: ${stats.cacheMisses}</div>
<div class="stat">Data Saved: ${savedMB} MB</div>
<div class="stat">Last Reset: ${stats.lastReset}</div>
<p style="margin-top:10px;color:#555;">Auto-saves stats in Cloudflare KV.</p></div>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
// 🌐 Display main web interface (Home)
function getWebInterface() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>⚡ Bandwidth Hero Proxy</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:linear-gradient(135deg,#667eea,#764ba2);
      color:#222;min-height:100vh;padding:30px;}
    .container{max-width:900px;margin:0 auto;background:#fff;
      border-radius:20px;padding:30px;box-shadow:0 15px 45px rgba(0,0,0,0.25);}
    h1{color:#5c6bc0;margin-bottom:10px;font-size:2em;}
    p.subtitle{color:#555;margin-bottom:25px;}
    a.button{display:inline-block;background:#5c6bc0;color:#fff;
      padding:12px 22px;border-radius:8px;text-decoration:none;
      font-weight:600;margin-top:15px;transition:background 0.2s;}
    a.button:hover{background:#3949ab;}
    code{background:#f1f3f4;padding:4px 8px;border-radius:4px;color:#d63384;}
    section{margin-top:25px;}
    table{width:100%;border-collapse:collapse;margin-top:10px;}
    th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd;}
    th{background:#5c6bc0;color:white;}
    .footer{text-align:center;margin-top:25px;color:#555;font-size:0.9em;}
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Bandwidth Hero Proxy</h1>
    <p class="subtitle">A Cloudflare Worker for Tachiyomi & Bandwidth Hero Image Compression.</p>

    <section>
      <h2>🧭 Usage</h2>
      <p>Example endpoint:</p>
      <code>${location.origin}/?url=https%3A%2F%2Fexample.com%2Fimage.jpg&l=70&bw=1</code>

      <table>
        <thead>
          <tr><th>Parameter</th><th>Description</th><th>Example</th><th>Default</th></tr>
        </thead>
        <tbody>
          <tr><td><code>url</code></td><td>Image URL (encoded)</td>
              <td>url=https%3A%2F%2Fexample.com%2Fimg.jpg</td><td>required</td></tr>
          <tr><td><code>l</code></td><td>Quality (1–100)</td>
              <td>l=75</td><td>75</td></tr>
          <tr><td><code>bw</code></td><td>Grayscale mode (1=on)</td>
              <td>bw=1</td><td>0</td></tr>
          <tr><td><code>jpg</code> / <code>jpeg</code></td>
              <td>Force JPEG (1=on, 0=WebP)</td>
              <td>jpg=1</td><td>0 (WebP)</td></tr>
          <tr><td><code>debug</code></td><td>Show extra headers</td>
              <td>debug=1</td><td>0</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>🚀 Examples</h2>
      <p><code>${location.origin}/?url=https%3A%2F%2Fpicsum.photos%2F1200%2F1600&l=60</code></p>
      <p><code>${location.origin}/?url=https%3A%2F%2Fpicsum.photos%2F1200%2F1600&bw=1&l=70&jpg=1</code></p>
    </section>

    <section>
      <h2>📱 Tachiyomi Setup</h2>
      <ol>
        <li>Open Tachiyomi → <strong>Settings → Advanced</strong></li>
        <li>Set <strong>Custom Image Proxy</strong> to:</li>
        <code>${location.origin}/?url=</code>
      </ol>
    </section>

    <a href="/stats" class="button">📊 View Live Stats</a>
    <div class="footer">© 2025 Bandwidth Hero Proxy – Powered by Cloudflare Workers</div>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
