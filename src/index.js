// ========================
// 🖼️ Image Handling (Fixed wsrv.nl 403 issue)
// ========================
async function handleImageRequest(request, env, ctx) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const bw = url.searchParams.get("bw") === "1";
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));

  const parsedTarget = new URL(targetUrl);
  const referer = getRefererForHost(parsedTarget.hostname, targetUrl);
  const cache = caches.default;

  const cacheKey = new Request(
    `${targetUrl}-q${quality}-${jpeg ? "jpg" : "webp"}-${bw ? "bw" : "color"}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT", quality);
  }

  console.log(`📥 Fetching ${parsedTarget.hostname} | q=${quality}`);

  const wsrvParams = new URLSearchParams({
    url: targetUrl,
    q: quality.toString(),
    output: jpeg ? "jpg" : "webp",
  });
  if (bw) wsrvParams.set("il", "");
  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;

  // 🟢 Attempt 1: wsrv.nl — browser spoof headers
  let response = await fetch(wsrvUrl, {
    headers: {
      "Referer": "https://google.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  // 🟡 Attempt 2: direct fetch from CDN
  if (!response.ok || !(response.headers.get("content-type") || "").includes("image/")) {
    console.warn(`⚠️ wsrv.nl failed (${response.status}) — direct fetch`);
    response = await fetch(targetUrl, {
      headers: {
        "Referer": referer,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });

    // 🔁 Retry with fallback referer if still blocked
    if (response.status === 403) {
      console.warn("🔁 Retrying with fallback referer: https://mangabuddy.com/");
      response = await fetch(targetUrl, {
        headers: {
          "Referer": "https://mangabuddy.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          "Accept": "image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
    }
  }

  if (!response.ok) {
    console.error(`❌ Failed (${response.status}) ${targetUrl}`);
    return errorResponse(`Failed (${response.status})`, response.status);
  }

  const contentLength = parseInt(response.headers.get("content-length") || "0");
  const estimatedOriginal = Math.round(contentLength * 1.7);
  const bytesSaved = estimatedOriginal - contentLength;
  if (bytesSaved > 0) localStats.bytesSaved += bytesSaved;

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, startTime, "MISS", quality);
}
