// 🚀 Bandwidth Hero Cloudflare Worker v4.7 (Fixed Likemanga)
// ✅ Fixes wsrv.nl 403 errors + Likemanga referer
// ✅ Auto referer fix for Likemanga, Mangabuddy, NHentai, etc.
// ✅ Works in Tachiyomi & browsers
// ✅ Uses wsrv.nl compression with smart fallback

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// ========================
// 🔧 Smart Referer Mapping
// ========================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // Likemanga CDN - CRITICAL: Must use exact domain
  if (host.includes("likemanga.ink") || host.includes("likemanga.io") || host.includes("1kmgv")) {
    return "https://likemanga.ink/";
  }

  // Mangabuddy CDN
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host) || host.includes("1stkmgv1.com"))
    return "https://mangabuddy.com/";

  if (host.includes("mgcdn.xyz") || host.includes("mbbcdn.com"))
    return "https://res.mgcdn.xyz/";

  if (host.includes("readdetectiveconan.com") || host.includes("mangapill.com"))
    return "https://mangapill.com/";

  if (host.includes("hentaifox.com")) return "https://hentaifox.com/";
  if (host.includes("nhentai.net")) return "https://nhentai.net/";

  return `https://${hostname}/`;
}

// ========================
// ⚙️ Worker Entry Point
// ========================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleCORS();

    if (url.pathname === "/health")
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });

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

// ========================
// 🖼️ Image Handling (Fixed 403 issue)
// ========================
async function handleImageRequest(request, env, ctx) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const bw = url.searchParams.get("bw") === "1";
  const jpeg =
    url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));
  const debug = url.searchParams.get("debug") === "1";

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

  if (debug) console.log(`📥 Fetching ${parsedTarget.hostname} | Referer: ${referer}`);

  let response = null;
  let method = "none";

  // 🟢 Attempt 1: Try wsrv.nl compression first
  try {
    const wsrvParams = new URLSearchParams({
      url: targetUrl,
      q: quality.toString(),
      output: jpeg ? "jpg" : "webp",
    });
    if (bw) wsrvParams.set("il", "");
    const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;

    if (debug) console.log(`🔵 Trying wsrv.nl compression`);

    response = await fetch(wsrvUrl, {
      headers: {
        "Referer": referer,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });

    if (isImageResponse(response)) {
      method = "wsrv.nl";
      if (debug) console.log("✅ wsrv.nl compression success");
    } else {
      if (debug) console.log(`❌ wsrv.nl failed: ${response.status}`);
      response = null;
    }
  } catch (err) {
    if (debug) console.log(`❌ wsrv.nl error: ${err.message}`);
  }

  // 🟡 Attempt 2: Direct fetch with proper referer
  if (!response) {
    if (debug) console.log(`🟡 Trying direct fetch with referer: ${referer}`);

    try {
      response = await fetch(targetUrl, {
        headers: {
          "Referer": referer,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
          "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });

      if (isImageResponse(response)) {
        method = "direct";
        if (debug) console.log("✅ Direct fetch success");
      } else {
        if (debug) console.log(`❌ Direct fetch failed: ${response.status}`);
        response = null;
      }
    } catch (err) {
      if (debug) console.log(`❌ Direct fetch error: ${err.message}`);
    }
  }

  // 🔴 Attempt 3: Fallback referers
  if (!response) {
    const fallbacks = [
      "https://likemanga.ink/",
      "https://mangabuddy.com/",
      "https://google.com/",
    ];

    for (const fallbackReferer of fallbacks) {
      if (fallbackReferer === referer) continue; // Skip if already tried
      
      if (debug) console.log(`🔴 Trying fallback referer: ${fallbackReferer}`);

      try {
        response = await fetch(targetUrl, {
          headers: {
            "Referer": fallbackReferer,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
            "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          cf: { cacheEverything: true, cacheTtl: 604800 },
        });

        if (isImageResponse(response)) {
          method = `fallback-${fallbackReferer}`;
          if (debug) console.log(`✅ Success with fallback: ${fallbackReferer}`);
          break;
        }
      } catch (err) {
        if (debug) console.log(`❌ Fallback ${fallbackReferer} error: ${err.message}`);
      }
    }
  }

  // Final check
  if (!isImageResponse(response)) {
    console.error(`❌ All attempts failed for ${targetUrl}`);
    return errorResponse(
      `Failed to fetch image (tried compression + direct + fallbacks)`,
      response?.status || 502
    );
  }

  const len = parseInt(response.headers.get("content-length") || "0");
  const estimated = method === "wsrv.nl" ? Math.round(len * 1.6) : len;
  const saved = method === "wsrv.nl" ? Math.max(0, estimated - len) : 0;
  if (saved > 0) localStats.bytesSaved += saved;

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, startTime, `MISS-${method}`, quality);
}

// ========================
// 🧩 Helpers
// ========================
function isImageResponse(response) {
  if (!response || !response.ok) return false;
  const ct = response.headers.get("content-type") || "";
  return ct.startsWith("image/");
}

function addHeaders(response, startTime, cacheStatus, quality) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800");
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
    },
  });
}

function errorResponse(msg, status = 500) {
  return new Response(
    JSON.stringify({ error: msg, status, timestamp: new Date().toISOString() }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// ========================
// 📊 Stats & UI
// ========================
async function updateStats(env, delta) {
  for (const key in delta) localStats[key] = (localStats[key] || 0) + (delta[key] || 0);
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;

  try {
    const kvData =
      (await env.KV_STATS.get("stats", { type: "json" })) || {
        requests: 0,
        cacheHits: 0,
        cacheMisses: 0,
        bytesSaved: 0,
        lastReset: new Date().toISOString(),
      };
    for (const key in localStats)
      kvData[key] = (kvData[key] || 0) + localStats[key];
    await env.KV_STATS.put("stats", JSON.stringify(kvData));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    console.error("❌ KV update failed:", err);
  }
}

async function showStatsPage(env) {
  const stats =
    (await env.KV_STATS.get("stats", { type: "json" })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: "N/A",
    };
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate =
    stats.requests > 0
      ? ((stats.cacheHits / stats.requests) * 100).toFixed(1)
      : 0;
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h1>📊 Bandwidth Hero v4.7</h1>
<p>Total Requests: ${stats.requests}</p>
<p>Cache Hits: ${stats.cacheHits} (${hitRate}%)</p>
<p>Cache Misses: ${stats.cacheMisses}</p>
<p>Data Saved: ${savedMB} MB</p>
<p>Last Reset: ${stats.lastReset}</p>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

function getWebInterface() {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h2>⚡ Bandwidth Hero Proxy v4.7</h2>
<p>Usage: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&debug=1</code></p>
<ul>
<li>✅ wsrv.nl compression + smart fallback</li>
<li>✅ Auto referer for Likemanga, Mangabuddy, NHentai</li>
<li>✅ Multiple fallback attempts</li>
<li>✅ Works in Tachiyomi, browser</li>
</ul>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
