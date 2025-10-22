// 🚀 Bandwidth Hero Cloudflare Worker v4.3
// ✅ Auto mask when wsrv.nl fails (18+ safe)
// ✅ Full referer fix for Mangabuddy, Mangapill, Hentaifox, NHentai
// ✅ Compression + Cache + KV stats
// ✅ Works with Tachiyomi & Bandwidth Hero

// =================== CONFIG ===================
const MASK_PROXY = "https://proxy-img.zoro1.workers.dev/"; // 👈 your 2nd CF image proxy

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// =================== REFERER LOGIC ===================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // 🔹 Mangabuddy numbered CDNs
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    if (match) {
      return `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`;
    }
    return "https://mangabuddy.com/";
  }

  // 🔹 Mangabuddy backup CDN
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

// =================== WORKER ENTRY ===================
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

// =================== IMAGE LOGIC ===================
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

  // 🟢 Attempt 1: wsrv.nl
  let response = await fetch(wsrvUrl, {
    headers: {
      "Referer": referer,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
      "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });

  // 🟡 Attempt 2: direct fetch
  if (!response.ok || !(response.headers.get("content-type") || "").includes("image/")) {
    console.warn(`⚠️ wsrv.nl failed (${response.status}) — direct or mask retry`);

    let referer1 = getRefererForHost(parsedTarget.hostname, targetUrl);
    console.log(`🔗 Using referer: ${referer1}`);

    response = await fetch(targetUrl, {
      headers: {
        "Referer": referer1,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });

    // 🔁 Attempt 3: retry with fallback referer
    if (response.status === 403 || response.status === 404) {
      console.warn(`🔁 Retrying masked via ${MASK_PROXY}`);
      // 🔁 Retrying masked via ${MASK_PROXY} (preserves compression params)
const maskedUrl = `${MASK_PROXY}?url=${encodeURIComponent(targetUrl)}&l=${quality}&jpg=${jpeg ? 1 : 0}&bw=${bw ? 1 : 0}`;
console.warn(`🔁 Mask retry -> ${maskedUrl}`);
response = await fetch(maskedUrl, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
    "Accept": "image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
  cf: { cacheEverything: true, cacheTtl: 604800 },
});

      response = await fetch(maskedUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
          "Accept": "image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
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

// =================== HELPERS ===================
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
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }
  );
}

// =================== STATS & UI ===================
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
<h1>📊 Bandwidth Hero v4.3</h1>
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
<h2>⚡ Bandwidth Hero Proxy v4.3</h2>
<p>Usage: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
<ul>
<li>Auto referer for Mangabuddy, Mangapill, Hentaifox, NHentai</li>
<li>Auto mask 18+ via <code>${MASK_PROXY}</code></li>
<li>Stats: <a href="/stats">/stats</a></li>
<li>Health: <a href="/health">/health</a></li>
</ul>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}


