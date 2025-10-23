// 🚀 Bandwidth Hero Cloudflare Worker v4.6
// ✅ Fixed masked compression (no double encoding)
// ✅ Auto referer for Mangabuddy, Mangapill, Hentaifox, NHentai
// ✅ Compression + Cache + KV Stats
// ✅ Dual proxy (images.weserv.nl + wsrv.nl)

const MASK_PROXY = "https://proxy-img.zoro1.workers.dev/"; // your 2nd worker proxy
let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// =================== REFERER LOGIC ===================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // 🔹 Mangabuddy CDN
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    if (match)
      return `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`;
    return "https://mangabuddy.com/";
  }

  if (host.includes("mgcdn.xyz") || host.includes("mbbcdn.com"))
    return "https://res.mgcdn.xyz/";

  if (host.includes("readdetectiveconan.com") || host.includes("mangapill.com"))
    return "https://mangapill.com/";

  if (host.includes("hentaifox.com")) return "https://hentaifox.com/";
  if (host.includes("nhentai.net")) return "https://nhentai.net/";

  return `https://${hostname}/`;
}

// =================== WORKER ENTRY ===================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleCORS();

    if (url.pathname === "/health")
      return new Response(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
        }),
        { headers: { "Content-Type": "application/json" } }
      );

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

// =================== IMAGE HANDLING ===================
async function handleImageRequest(request, env, ctx) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const debug = url.searchParams.get("debug") === "1";

  if (url.searchParams.get("mask") === "1") {
    if (debug) console.log("🎭 MASK MODE fetch");
    return await fetchDirectImage(targetUrl, debug);
  }

  const bw = url.searchParams.get("bw") === "1";
  const jpeg =
    url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));

  const parsedTarget = new URL(targetUrl);
  const referer = getRefererForHost(parsedTarget.hostname, targetUrl);
  const cache = caches.default;
  const cacheKey = new Request(
    `${targetUrl}##q${quality}-${jpeg ? "jpg" : "webp"}-${bw ? "bw" : "color"}`
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    if (debug) console.log("✅ CACHE HIT");
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT", quality);
  }

  if (debug) console.log(`📥 Fetching ${parsedTarget.hostname} | q=${quality}`);

  const proxies = [
    { name: "images.weserv.nl", url: "https://images.weserv.nl/" },
    { name: "wsrv.nl", url: "https://wsrv.nl/" },
  ];

  let response = null;
  let usedMethod = "none";

  // 🟢 Attempt 1: Normal compression
  for (const proxy of proxies) {
    const proxyUrl = `${proxy.url}?url=${targetUrl}&q=${quality}&output=${
      jpeg ? "jpg" : "webp"
    }${bw ? "&il" : ""}`;

    if (debug) console.log(`🔵 Trying ${proxyUrl}`);

    try {
      const r = await fetch(proxyUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });
      if (r.ok && (r.headers.get("content-type") || "").includes("image/")) {
        response = r;
        usedMethod = proxy.name;
        break;
      }
    } catch (err) {
      if (debug) console.log(`❌ ${proxy.name} error: ${err.message}`);
    }
  }

  // 🟡 Attempt 2: Masked compression fallback
  if (!response) {
    if (debug) console.log("🟡 Direct failed — trying masked compression");

    for (const proxy of proxies) {
      // Properly encode: inner targetUrl gets encoded, then full mask URL gets encoded for wsrv
      const maskedSrc = `${MASK_PROXY}?url=${encodeURIComponent(targetUrl)}`;
      const maskedUrl = `${proxy.url}?url=${encodeURIComponent(maskedSrc)}&q=${quality}&output=${
        jpeg ? "jpg" : "webp"
      }${bw ? "&il" : ""}`;

      if (debug) console.log(`🎭 Masked ${proxy.name} -> ${maskedUrl}`);

      try {
        const r = await fetch(maskedUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
            Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          },
          cf: { cacheEverything: true, cacheTtl: 604800 },
        });

        if (r.ok && (r.headers.get("content-type") || "").includes("image/")) {
          response = r;
          usedMethod = `masked-${proxy.name}`;
          if (debug) console.log(`✅ Masked ${proxy.name} SUCCESS`);
          break;
        } else {
          if (debug) console.log(`❌ Masked ${proxy.name} failed: ${r.status}`);
        }
      } catch (err) {
        if (debug) console.log(`❌ Masked ${proxy.name} error:`, err.message);
      }
    }
  }

  // 🔴 Attempt 3: Direct fetch fallback
  if (!response) {
    if (debug) console.log("🔴 All compression failed — fetching direct");
    usedMethod = "direct";
    response = await fetchDirectImage(targetUrl, debug);
  }

  if (!response || !response.ok) {
    console.error(`❌ Failed (${response?.status}) ${targetUrl}`);
    return errorResponse(`Failed (${response?.status})`, response?.status || 502);
  }

  const type = response.headers.get("content-type") || "";
  if (!type.includes("image/")) {
    console.error("❌ Not an image:", type);
    return errorResponse("Not an image", 502);
  }

  // Track data saved
  const len = parseInt(response.headers.get("content-length") || "0");
  const estOriginal = Math.round(len * 1.7);
  const saved = usedMethod !== "direct" ? Math.max(0, estOriginal - len) : 0;
  if (saved > 0) localStats.bytesSaved += saved;

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, startTime, `MISS-${usedMethod}`, quality);
}

// =================== DIRECT FETCH ===================
async function fetchDirectImage(targetUrl, debug = false) {
  const parsed = new URL(targetUrl);
  const referer = getRefererForHost(parsed.hostname, targetUrl);
  if (debug) console.log(`🎯 Direct fetch with referer: ${referer}`);

  try {
    return await fetch(targetUrl, {
      headers: {
        Referer: referer,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cf: { cacheEverything: true, cacheTtl: 604800 },
    });
  } catch (err) {
    console.error("❌ Direct fetch failed:", err.message);
    return new Response("Direct fetch failed", { status: 502 });
  }
}

// =================== HELPERS ===================
function addHeaders(response, start, cacheStatus, quality) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800");
  headers.set("X-Cache-Status", cacheStatus);
  headers.set("X-Quality", quality);
  headers.set("X-Response-Time", `${Date.now() - start}ms`);
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

// =================== STATS & UI ===================
async function updateStats(env, delta) {
  for (const k in delta) localStats[k] = (localStats[k] || 0) + (delta[k] || 0);
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;

  try {
    const kv = (await env.KV_STATS.get("stats", { type: "json" })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: new Date().toISOString(),
    };
    for (const k in localStats) kv[k] = (kv[k] || 0) + localStats[k];
    await env.KV_STATS.put("stats", JSON.stringify(kv));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    console.error("❌ KV update failed:", err.message);
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
  const mb = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hit = stats.requests
    ? ((stats.cacheHits / stats.requests) * 100).toFixed(1)
    : 0;
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h1>📊 Bandwidth Hero v4.6</h1>
<p>Total Requests: ${stats.requests}</p>
<p>Cache Hits: ${stats.cacheHits} (${hit}%)</p>
<p>Cache Misses: ${stats.cacheMisses}</p>
<p>Data Saved: ${mb} MB</p>
<p>Last Reset: ${stats.lastReset}</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

function getWebInterface() {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h2>⚡ Bandwidth Hero Proxy v4.6</h2>
<p>Usage: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
<ul>
<li>✅ Auto referer + Mask compression</li>
<li>✅ wsrv.nl & images.weserv.nl fallback</li>
<li>✅ Works with Tachiyomi + Bandwidth Hero</li>
<li>📊 <a href="/stats">Stats</a> | 💚 <a href="/health">Health</a></li>
</ul></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
