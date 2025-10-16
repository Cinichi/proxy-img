// 🚀 Tachiyomi / Manhwa Proxy (Browser UA + Fallback + Quality/Grayscale)
// ✅ wsrv.nl compression with working quality & grayscale
// ✅ Chrome Android User-Agent
// ✅ Referer spoof for hotlinking protection
// ✅ Automatic 403 fallback (direct fetch)
// ✅ Per-quality Cloudflare cache key
// ✅ Safe headers, metrics, and 7d caching

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    if (request.method === "OPTIONS") return handleCORS();
    if (!["GET", "HEAD"].includes(request.method))
      return errorResponse("Method not allowed", 405);

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return getWebInterface();

    // Validate
    try {
      const parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol))
        return errorResponse("Invalid protocol", 400);
    } catch {
      return errorResponse("Invalid URL", 400);
    }

    // Tachiyomi / Bandwidth Hero style params
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

// 🧠 Compression handler
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
  wsrvParams.set("ll", "0"); // force lossy
  wsrvParams.set("default", "1");
  wsrvParams.set("n", "-1");

  if (width > 0) wsrvParams.set("w", width.toString());
  if (height > 0) wsrvParams.set("h", height.toString());
  if (grayscale) wsrvParams.set("f", "greyscale");

  // 🔹 Spoof referer to bypass anti-hotlinking
  const origin = new URL(targetUrl).origin;
  wsrvParams.set("headers", `Referer:${origin}/`);

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;

  // Cache per quality value
  const cacheKey = new Request(`${wsrvUrl}&_q=${quality}`, {
    headers: request.headers,
  });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return addProxyHeaders(cached, startTime, "HIT-COMPRESSED");

  // Real browser UA
  const browserUA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.186 Mobile Safari/537.36";

  const response = await fetch(wsrvUrl, {
    headers: {
      "User-Agent": browserUA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: origin + "/",
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 604800, // 7 days
      polish: "off",
    },
  });

  // 🔸 Fallback if site returns 403
  if (response.status === 403) {
    console.warn("403 from wsrv.nl upstream → direct fetch fallback");
    return await handleDirectImage(targetUrl, browserUA, startTime);
  }

  if (!response.ok)
    return errorResponse(`Upstream failed (${response.status})`, response.status);

  const clone = response.clone();
  ctx.waitUntil(cache.put(cacheKey, clone));

  return addProxyHeaders(response, startTime, "MISS-COMPRESSED", quality);
}

// 🩵 Direct fallback (for anti-hotlink sites)
async function handleDirectImage(targetUrl, ua, startTime) {
  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": ua,
      Referer: new URL(targetUrl).origin + "/",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  if (!response.ok)
    return errorResponse(`Direct fetch failed (${response.status})`, response.status);

  return addProxyHeaders(response, startTime, "MISS-DIRECT");
}

// 🧱 Add response headers
function addProxyHeaders(response, startTime, cacheStatus, quality = 0) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Compressed-By", "wsrv.nl");
  headers.set("X-Quality", quality.toString());
  headers.set("X-Powered-By", "Tachiyomi-Proxy");
  headers.delete("Content-Security-Policy");
  headers.delete("X-Frame-Options");
  return new Response(response.body, { status: response.status, headers });
}

// ⚙️ CORS handler
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

// 🧾 Error response
function errorResponse(message, status) {
  return new Response(
    JSON.stringify({
      error: message,
      status,
      timestamp: new Date().toISOString(),
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// 🌐 Info page
function getWebInterface() {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <title>Tachiyomi Proxy (Browser UA)</title>
  <style>
    body { font-family: sans-serif; background: #f0f4f8; padding: 40px; max-width: 850px; margin: auto; }
    h1 { color: #4f46e5; }
    code { background: #f9fafb; padding: 4px 8px; border-radius: 5px; }
  </style>
</head>
<body>
  <h1>📚 Tachiyomi Proxy (Browser UA + Fallback)</h1>
  <ul>
    <li>Supports: <code>?quality=</code>, <code>?grayscale=1</code>, <code>?jpeg=1</code></li>
    <li>Lossy WebP / JPG compression via wsrv.nl</li>
    <li>Fallback for hotlink-protected sites</li>
  </ul>
  <h3>Example:</h3>
  <code>${location.origin}/?url=https%3A%2F%2Fexample.com%2Fimg.jpg&quality=50</code><br><br>
  <code>${location.origin}/?url=https%3A%2F%2Fexample.com%2Fimg.jpg&grayscale=1&quality=70</code>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
