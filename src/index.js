// 🚀 Bandwidth Hero Cloudflare Worker v5.0
// ✅ Native compression (cf.image) — works on any CDN
// ✅ Auto referer detection for Mangabuddy, Mangapill, Hentaifox, NHentai
// ✅ Cache + KV stats + fallback support

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// ========================
// 🔧 Smart Referer Mapping
// ========================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // 🔹 Mangabuddy numbered CDNs (auto-detect)
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host) || host.includes("1stkmgv1.com")) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    if (match) {
      return `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`;
    }
    return "https://mangabuddy.com/";
  }

  // 🔹 MangaBuddy backup CDN
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

// ========================
// ⚙️ Worker Entry Point
// ========================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleCORS();

    // Health
    if (url.pathname === "/health")
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });

    // Stats
    if (url.pathname === "/stats") return await showStatsPage(env);

    // Reset
    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset.", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // UI
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
// 🖼️ Image Handling
// ========================
async function handleImageRequest(request, env, ctx) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const bw = url.searchParams.get("bw") === "1";
  const jpeg = url.searchParams.get("jpg") === "1";
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
    if (debug) console.log("✅ Cache hit");
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT", quality);
  }

  if (debug) console.log(`📥 Fetching ${parsedTarget.hostname} | q=${quality}`);

  try {
    // Native Cloudflare compression
    const response = await fetch(targetUrl, {
      headers: {
        "Referer": referer,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      },
      cf: {
        image: {
          format: jpeg ? "jpeg" : "webp",
          quality: quality,
          grayscale: bw,
          metadata: "none",
        },
        cacheTtl: 604800,
        cacheEverything: true,
      },
    });

    if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);

    const contentLength = parseInt(response.headers.get("content-length") || "0");
    const estimatedOriginal = Math.round(contentLength * 1.6);
    const bytesSaved = estimatedOriginal - contentLength;
    if (bytesSaved > 0) localStats.bytesSaved += bytesSaved;

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    await updateStats(env, { requests: 1, cacheMisses: 1 });

    if (debug) console.log(`💾 Compressed ${parsedTarget.hostname} | q=${quality}`);
    return addHeaders(response, startTime, "MISS-CF", quality);
  } catch (err) {
    console.error("❌ Direct compression failed:", err);
    return errorResponse(`Compression failed: ${err.message}`, 500);
  }
}

// ========================
// 🧩 Helpers
// ========================
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
      "Access-Control-Max-Age": "86400",
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
// 📊 Stats + UI
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
    stats.requests > 0 ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) : 0;
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h1>📊 Bandwidth Hero v5.0</h1>
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
<h2>⚡ Bandwidth Hero Proxy v5.0</h2>
<p>Usage: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0&debug=1</code></p>
<ul>
<li>✅ Uses Cloudflare's <code>cf.image</code> for compression</li>
<li>✅ Works on protected CDNs (like Mangabuddy, Mangapill, Hentaifox)</li>
<li>✅ Auto caching & stats</li>
<li>✅ Compatible with Tachiyomi</li>
<li>📊 <a href="/stats">Stats</a> | 🔄 <a href="/reset">Reset</a> | 💚 <a href="/health">Health</a></li>
</ul>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
