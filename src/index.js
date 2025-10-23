// 🚀 Bandwidth Hero Cloudflare Worker v4.7 (403 Bypass Edition)
// ✅ Fixes wsrv.nl 403 errors (browser-like spoof)
// ✅ Auto referer fix for Likemanga, Mangabuddy, NHentai, etc.
// ✅ Works in Tachiyomi & browsers
// ✅ Uses wsrv.nl compression (no native Cloudflare compression)

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// ========================
// 🔧 Smart Referer Mapping
// ========================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host) || host.includes("1stkmgv1.com"))
    return "https://mangabuddy.com/";

  if (host.includes("likemanga.ink") || host.includes("likemanga.io"))
    return "https://likemanga.io/";

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
// 🖼️ Image Handling (Fixed wsrv.nl 403 issue)
// ========================
async function handleImageRequest(request, env, ctx) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const bw = url.searchParams.get("bw") === "1";
  const jpeg =
    url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
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

  // 🟢 Attempt 1: wsrv.nl with browser spoof
  let response = await fetch(wsrvUrl, {
    headers: {
      "Referer": "https://google.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  // 🟡 Attempt 2: direct fetch if wsrv fails
  if (!isImageResponse(response)) {
    console.warn(`⚠️ wsrv.nl failed (${response.status}) — direct fetch`);
    response = await fetch(targetUrl, {
      headers: {
        "Referer": referer,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });

    // 🔁 Retry with fallback referer
    if (response.status === 403) {
      console.warn("🔁 Retrying with fallback referer: https://mangabuddy.com/");
      response = await fetch(targetUrl, {
        headers: {
          "Referer": "https://mangabuddy.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
          "Accept": "image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
    }
  }

  if (!isImageResponse(response)) {
    console.error(`❌ Failed (${response.status}) ${targetUrl}`);
    return errorResponse(`Failed (${response.status})`, response.status);
  }

  const len = parseInt(response.headers.get("content-length") || "0");
  const estimated = Math.round(len * 1.6);
  const saved = estimated - len;
  if (saved > 0) localStats.bytesSaved += saved;

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, startTime, "MISS", quality);
}

// ========================
// 🧩 Helpers
// ========================
function isImageResponse(response) {
  if (!response) return false;
  const ct = response.headers.get("content-type") || "";
  return response.ok && ct.startsWith("image/");
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
<p>Usage: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0</code></p>
<ul>
<li>✅ wsrv.nl 403 Bypass + compression</li>
<li>✅ Auto referer for Likemanga, Mangabuddy, NHentai</li>
<li>✅ Works in Tachiyomi, browser</li>
</ul>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
