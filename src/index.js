// 🚀 Bandwidth Hero Cloudflare Worker v4.7
// ✅ Fixes "libvips image too large" (auto JPEG fallback)
// ✅ Auto referer + masked fallback for protected CDNs
// ✅ Works with Tachiyomi + Bandwidth Hero

const MASK_PROXY = "https://proxy-img.zoro1.workers.dev/"; // secondary proxy

let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();

// =================== REFERER LOGIC ===================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    if (match) return `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`;
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

// =================== ENTRY ===================
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

// =================== IMAGE HANDLER ===================
async function handleImageRequest(request, env, ctx) {
  const start = Date.now();
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");
  const debug = url.searchParams.get("debug") === "1";
  if (!targetUrl) return errorResponse("Missing url", 400);

  if (url.searchParams.get("mask") === "1") {
    if (debug) console.log("🎭 Mask fetch mode");
    return await fetchDirectImage(targetUrl, debug);
  }

  const bw = url.searchParams.get("bw") === "1";
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";
  const q = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || 75));

  const parsed = new URL(targetUrl);
  const referer = getRefererForHost(parsed.hostname, targetUrl);
  const cache = caches.default;
  const key = new Request(`${targetUrl}#${q}-${jpeg ? "jpg" : "webp"}-${bw ? "bw" : "color"}`);

  const cached = await cache.match(key);
  if (cached) {
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, start, "HIT", q);
  }

  if (debug) console.log(`📥 Fetching ${parsed.hostname} | q=${q}`);

  const proxies = [
    { name: "images.weserv.nl", base: "https://images.weserv.nl/" },
    { name: "wsrv.nl", base: "https://wsrv.nl/" },
  ];

  let response = null;
  let method = "none";

  // 🟢 Try compression via weserv/wsrv
  for (const proxy of proxies) {
    const url1 = `${proxy.base}?url=${targetUrl}&q=${q}&output=${jpeg ? "jpg" : "webp"}${
      bw ? "&il" : ""
    }`;

    if (debug) console.log(`🔵 Trying ${url1}`);

    try {
      const r = await fetch(url1, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      });

      if (r.ok && (r.headers.get("content-type") || "").includes("image/")) {
        response = r;
        method = proxy.name;
        break;
      }

      // ⚠️ JPEG fallback for libvips 400 error
      if (r.status === 400) {
        const errText = await r.text();
        if (errText.includes("image too large")) {
          if (debug) console.log(`🟡 ${proxy.name}: image too large, retry as JPEG`);
          const retryUrl = `${proxy.base}?url=${targetUrl}&q=${q}&output=jpg${bw ? "&il" : ""}`;
          const retry = await fetch(retryUrl);
          if (retry.ok && (retry.headers.get("content-type") || "").includes("image/")) {
            response = retry;
            method = `${proxy.name}-jpeg-fallback`;
            break;
          }
        }
      }
    } catch (e) {
      if (debug) console.log(`❌ ${proxy.name} error: ${e.message}`);
    }
  }

  // 🟡 Masked compression fallback
  if (!response) {
    if (debug) console.log("🟡 Compression failed, trying masked");

    for (const proxy of proxies) {
      const maskedSrc = `${MASK_PROXY}?url=${targetUrl}`;
      const maskedUrl = `${proxy.base}?url=${maskedSrc}&q=${q}&output=${jpeg ? "jpg" : "webp"}${
        bw ? "&il" : ""
      }`;

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
          method = `masked-${proxy.name}`;
          break;
        }

        // Fallback JPEG retry for 400
        if (r.status === 400) {
          const errText = await r.text();
          if (errText.includes("image too large")) {
            if (debug) console.log(`🟡 Masked ${proxy.name}: retry as JPEG`);
            const retryUrl = maskedUrl.replace("output=webp", "output=jpg");
            const retry = await fetch(retryUrl);
            if (retry.ok && (retry.headers.get("content-type") || "").includes("image/")) {
              response = retry;
              method = `${proxy.name}-jpeg-fallback`;
              break;
            }
          }
        }
      } catch (e) {
        if (debug) console.log(`❌ Masked ${proxy.name} error: ${e.message}`);
      }
    }
  }

  // 🔴 Final fallback: direct fetch
  if (!response) {
    if (debug) console.log("🔴 All compression failed, direct fetch");
    method = "direct";
    response = await fetchDirectImage(targetUrl, debug);
  }

  if (!response || !response.ok) return errorResponse(`Failed (${response?.status})`, response?.status || 502);

  // Cache + Stats
  ctx.waitUntil(cache.put(key, response.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });

  return addHeaders(response, start, method, q);
}

// =================== DIRECT FETCH ===================
async function fetchDirectImage(targetUrl, debug = false) {
  const u = new URL(targetUrl);
  const ref = getRefererForHost(u.hostname, targetUrl);
  if (debug) console.log(`🎯 Direct fetch referer: ${ref}`);

  return await fetch(targetUrl, {
    headers: {
      Referer: ref,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    },
    cf: { cacheEverything: true, cacheTtl: 604800 },
  });
}

// =================== HELPERS ===================
function addHeaders(r, start, cacheStatus, q) {
  const h = new Headers(r.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Cache-Control", "public, max-age=604800");
  h.set("X-Cache-Status", cacheStatus);
  h.set("X-Quality", q);
  h.set("X-Response-Time", `${Date.now() - start}ms`);
  return new Response(r.body, { status: r.status, headers: h });
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

function errorResponse(msg, code = 500) {
  return new Response(JSON.stringify({ error: msg, code }), {
    status: code,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// =================== STATS ===================
async function updateStats(env, d) {
  for (const k in d) localStats[k] = (localStats[k] || 0) + (d[k] || 0);
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;
  try {
    const kv = (await env.KV_STATS.get("stats", { type: "json" })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: new Date().toISOString(),
    };
    for (const k in localStats) kv[k] += localStats[k];
    await env.KV_STATS.put("stats", JSON.stringify(kv));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (e) {
    console.error("KV update failed:", e.message);
  }
}

// =================== UI ===================
async function showStatsPage(env) {
  const s = (await env.KV_STATS.get("stats", { type: "json" })) || {};
  const saved = ((s.bytesSaved || 0) / 1024 / 1024).toFixed(2);
  return new Response(
    `<!doctype html><body style="font-family:sans-serif;padding:40px;">
<h2>📊 Bandwidth Hero v4.7</h2>
<p>Requests: ${s.requests || 0}</p>
<p>Cache Hits: ${s.cacheHits || 0}</p>
<p>Cache Misses: ${s.cacheMisses || 0}</p>
<p>Data Saved: ${saved} MB</p>
<p><a href="/reset">Reset Stats</a></p>
</body>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

function getWebInterface() {
  return new Response(
    `<!doctype html><body style="font-family:sans-serif;padding:40px;">
<h2>⚡ Bandwidth Hero Proxy v4.7</h2>
<p>Usage: <code>?url=&lt;image&gt;&l=75&jpg=0</code></p>
<ul><li>Auto referer + masked fallback</li>
<li>JPEG retry for large images</li>
<li>Stats: <a href="/stats">/stats</a></li></ul></body>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
