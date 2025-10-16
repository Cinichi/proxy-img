// 🚀 Bandwidth Hero Compatible Cloudflare Worker
// ✅ Full Tachiyomi compatibility (uses bw, l, jpeg, url params)
// ✅ Compression via wsrv.nl (libvips — same as sharp)
// ✅ Browser User-Agent for anti-hotlink bypass
// ✅ Grayscale + quality supported
// ✅ 7-day cache + per-quality key
// ✅ Automatic fallback if wsrv.nl or host fails

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    if (request.method === "OPTIONS") return handleCORS();
    if (!["GET", "HEAD"].includes(request.method))
      return errorResponse("Method not allowed", 405);

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return getWebInterface();

    // Validate URL
    try {
      const parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol))
        return errorResponse("Invalid protocol", 400);
    } catch {
      return errorResponse("Invalid URL", 400);
    }

    // 📦 Bandwidth Hero-style parameters
    const bw = url.searchParams.get("bw") !== "0"; // 1 = grayscale
    const quality = parseInt(url.searchParams.get("l")) || 70; // "l" = quality
    const jpeg = url.searchParams.get("jpeg") === "1";
    const debug = url.searchParams.get("debug") === "1";

    try {
      return await handleCompressedImage(
        request,
        targetUrl,
        quality,
        bw,
        jpeg,
        startTime,
        ctx,
        debug
      );
    } catch (err) {
      console.error("Fatal error:", err);
      return errorResponse("Internal Server Error", 500);
    }
  },
};

// 🧠 Image compressor (via wsrv.nl)
async function handleCompressedImage(
  request,
  targetUrl,
  quality,
  grayscale,
  jpeg,
  startTime,
  ctx,
  debug = false
) {
  const wsrvParams = new URLSearchParams();
  wsrvParams.set("url", targetUrl);
  wsrvParams.set("q", quality.toString());
  wsrvParams.set("output", jpeg ? "jpg" : "webp");
  wsrvParams.set("ll", "0"); // force lossy
  wsrvParams.set("default", "1");
  wsrvParams.set("n", "-1");

  if (grayscale) wsrvParams.set("f", "greyscale");
  wsrvParams.set("headers", `Referer:${new URL(targetUrl).origin}/`);

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}&_q=${quality}`;

  const cache = caches.default;
  const cacheKey = new Request(wsrvUrl);
  const cached = await cache.match(cacheKey);
  if (cached && !debug) return addHeaders(cached, startTime, "HIT-COMPRESSED", quality);

  const browserUA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";

  const response = await fetch(wsrvUrl, {
    headers: {
      "User-Agent": browserUA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: new URL(targetUrl).origin + "/",
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 604800, // 7 days
      polish: "off",
    },
  });

  if (response.status === 403 || !response.ok) {
    console.warn(`wsrv.nl failed (${response.status}), fallback direct`);
    return await handleDirectImage(targetUrl, browserUA, startTime);
  }

  const clone = response.clone();
  ctx.waitUntil(cache.put(cacheKey, clone));

  return addHeaders(response, startTime, "MISS-COMPRESSED", quality, wsrvUrl, debug);
}

// 🩵 Fallback direct fetch
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

  return addHeaders(response, startTime, "MISS-DIRECT");
}

// 🧾 Add diagnostic headers
function addHeaders(response, startTime, cacheStatus, quality = 0, wsrvUrl = "", debug = false) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800, immutable");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Response-Time", `${Date.now() - startTime}ms`);
  headers.set("X-Compressed-By", "wsrv.nl");
  headers.set("X-Quality", quality.toString());
  headers.set("X-Powered-By", "Bandwidth-Hero-Worker");

  headers.delete("Content-Security-Policy");
  headers.delete("X-Frame-Options");

  if (debug) {
    headers.set("X-Debug-WSRV-URL", wsrvUrl);
  }

  return new Response(response.body, { status: response.status, headers });
}

// 🧱 Error response
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

// 🌐 Info page
function getWebInterface() {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <title>Bandwidth Hero Proxy (Cloudflare Edition)</title>
  <style>
    body { font-family: sans-serif; background: #f0f4f8; padding: 40px; max-width: 850px; margin: auto; }
    h1 { color: #4f46e5; }
    code { background: #f9fafb; padding: 4px 8px; border-radius: 5px; }
  </style>
</head>
<body>
  <h1>⚡ Bandwidth Hero (Cloudflare Worker)</h1>
  <p>Compatible with Tachiyomi and Bandwidth Hero Extension</p>
  <ul>
    <li><strong>Params:</strong> <code>?url=</code>, <code>&l=</code> (quality), <code>&bw=1</code> (grayscale), <code>&jpeg=1</code></li>
    <li>Output: WebP (default), JPEG (if &jpeg=1)</li>
    <li>Cache: 7 days per-quality level</li>
  </ul>
  <h3>Example:</h3>
  <code>${location.origin}/?url=https%3A%2F%2Fexample.com%2Fimage.jpg&l=50&bw=1</code><br><br>
  <code>${location.origin}/?url=https%3A%2F%2Fexample.com%2Fimage.jpg&jpeg=1&l=70</code>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
      }
