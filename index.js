// 🚀 Tachiyomi / Manhwa Proxy (Enhanced Edition)
// ✅ Compression via wsrv.nl
// ✅ Cloudflare Edge Cache (7 days)
// ✅ Range requests (streaming support)
// ✅ Strong error handling & metrics
// ✅ Safe CORS + Header cleanup
// ✅ Works with Tachiyomi Bandwidth Hero mode

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    // Handle preflight
    if (request.method === "OPTIONS") return handleCORS();

    // Only GET and HEAD
    if (!["GET", "HEAD"].includes(request.method))
      return errorResponse("Method not allowed", 405);

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) return getWebInterface();

    // Validate URL
    let parsed;
    try {
      parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol))
        return errorResponse("Invalid protocol", 400);
    } catch {
      return errorResponse("Invalid URL", 400);
    }

    // Compression params (Tachiyomi Bandwidth Hero style)
    const quality = parseInt(url.searchParams.get("quality")) || 70;
    const grayscale = url.searchParams.get("grayscale") === "1";
    const jpeg = url.searchParams.get("jpeg") === "1";
    const width = parseInt(url.searchParams.get("width")) || 0;
    const height = parseInt(url.searchParams.get("height")) || 0;

    try {
      return await handleCompressedImage(
        request,
        targetUrl,
        quality,
        grayscale,
        jpeg,
        width,
        height,
        startTime,
        ctx
      );
    } catch (err) {
      console.error("Fatal error:", err);
      return errorResponse("Internal Server Error", 500);
    }
  },
};

// 🧩 Core compression handler
async function handleCompressedImage(
  request,
  targetUrl,
  quality,
  grayscale,
  jpeg,
  width,
  height,
  startTime,
  ctx
) {
  const wsrvParams = new URLSearchParams();
  wsrvParams.set("url", targetUrl);
  wsrvParams.set("q", quality.toString());
  wsrvParams.set("output", jpeg ? "jpg" : "webp");
  wsrvParams.set("default", "1");
  wsrvParams.set("n", "-1");
  if (width > 0) wsrvParams.set("w", width.toString());
  if (height > 0) wsrvParams.set("h", height.toString());
  if (grayscale) wsrvParams.set('f', 'greyscale');;

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;

  const cache = caches.default;
  const cacheKey = new Request(wsrvUrl, { headers: request.headers });

  // Check cache first
  const cached = await cache.match(cacheKey);
  if (cached) return addProxyHeaders(cached, startTime, "HIT");

  // Fetch image with extended options
  const response = await fetch(wsrvUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 14; TachiyomiProxy) AppleWebKit/537.36 (KHTML, like Gecko)",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: targetUrl,
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 604800, // 7 days
      polish: "off", // keep original quality
    },
  });

  // Handle failed fetch
  if (!response.ok) {
    return errorResponse(`Upstream failed (${response.status})`, response.status);
  }

  // Support for range requests (partial content)
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader && response.status === 200) {
    const buffer = await response.arrayBuffer();
    const size = buffer.byteLength;
    const range = parseRangeHeader(rangeHeader, size);

    if (range) {
      const chunk = buffer.slice(range.start, range.end + 1);
      const headers = new Headers(response.headers);
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      headers.set("Content-Length", chunk.byteLength);
      headers.set("Accept-Ranges", "bytes");
      return new Response(chunk, { status: 206, headers });
    }
  }

  // Cache clone and respond
  const clone = response.clone();
  ctx.waitUntil(cache.put(cacheKey, clone));

  return addProxyHeaders(response, startTime, "MISS");
}

// 🧠 Range parser helper
function parseRangeHeader(rangeHeader, size) {
  const matches = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!matches) return null;
  const start = parseInt(matches[1]);
  const end = matches[2] ? parseInt(matches[2]) : size - 1;
  if (isNaN(start) || isNaN(end) || start >= size || end >= size) return null;
  return { start, end };
}

// 🧾 Proxy header injector
function addProxyHeaders(response, startTime, cacheStatus) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Powered-By", "Tachiyomi-Proxy");
  headers.set("Accept-Ranges", "bytes");

  // Security cleanup
  headers.delete("Content-Security-Policy");
  headers.delete("X-Frame-Options");

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

// 🧱 Utility: Standard JSON errors
function errorResponse(message, status) {
  const body = JSON.stringify({
    error: message,
    status,
    timestamp: new Date().toISOString(),
  });
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// 🧰 Utility: CORS handler
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

// 🌐 Web Interface (Dashboard)
function getWebInterface() {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <title>Tachiyomi Proxy (Enhanced)</title>
  <style>
    body { font-family: sans-serif; background: #f0f4f8; padding: 40px; max-width: 850px; margin: auto; }
    h1 { color: #4f46e5; }
    code { background: #f9fafb; padding: 4px 8px; border-radius: 5px; }
    .metric { background: #fff; border-left: 4px solid #4f46e5; padding: 10px; margin: 10px 0; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>📚 Tachiyomi / Manhwa Proxy (Enhanced)</h1>
  <p>Compression via <a href="https://wsrv.nl" target="_blank">wsrv.nl</a> + Cloudflare Edge cache (7d)</p>
  <div class="metric">
    ✅ Error Handling • ✅ Range Support • ✅ Cache • ✅ Metrics • ✅ Safe CORS
  </div>
  <h2>Usage:</h2>
  <ol>
    <li>In Tachiyomi → Settings → Advanced → <b>Bandwidth Hero Proxy</b></li>
    <li>Enter: <code>${location.origin}/?url=</code></li>
    <li>Optional params: <code>&quality=60</code>, <code>&jpeg=1</code>, <code>&grayscale=1</code></li>
  </ol>
  <h2>Example:</h2>
  <code>${location.origin}/?url=https%3A%2F%2Fexample.com%2Fpage1.jpg&quality=50</code>
  <p>Edge cached for 7 days • Cloudflare optimized</p>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
