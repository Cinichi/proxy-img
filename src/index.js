// 🚀 Bandwidth Hero Cloudflare Worker v4.0 — Adaptive Edition
// ✅ Adaptive Cache TTL + Streaming + Parallel Fetch + ETag
// ✅ Safe for Cloudflare Free Tier
// ✅ Designed for Tachiyomi / Webtoon / Manhwa sites

// =================== GLOBALS ===================
let localStats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  bytesSaved: 0,
  compressed: 0,
  errors: 0,
};
let lastFlushTime = Date.now();
const pendingRequests = new Map();
const dedupTTL = 20000; // 20 sec dedup window

// =================== CONFIG ===================
const CONFIG = {
  SMALL_IMG_SKIP: 50 * 1024, // skip compression <50KB
  WS_TIMEOUT: 8000, // 8s per fetch
  CACHE_TTL_MIN: 300, // 5min
  CACHE_TTL_MAX: 86400, // 24h
  KV_FLUSH_INTERVAL: 15 * 60 * 1000, // 15min
  ADAPTIVE_QUALITY_STEP: 10,
  MIN_QUALITY: 40,
};

// =================== LOG (Reduced) ===================
function log(type, msg) {
  const icons = { info: "📥", cache: "✅", warn: "⚠️", error: "❌", net: "🌐" };
  console.log(`${icons[type] || "ℹ️"} ${msg}`);
}

// =================== MAIN HANDLER ===================
export default {
  async fetch(request, env, ctx) {
    const start = Date.now();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleCORS();

    if (url.pathname === "/stats") return await showStatsPage(env);
    if (url.pathname === "/reset") {
      await env.KV_STATS.delete("stats");
      return new Response("✅ Stats reset", { headers: { "Content-Type": "text/plain" } });
    }

    if (!url.searchParams.get("url")) return getWebInterface();

    try {
      const res = await handleImage(request, env, ctx, start);
      const time = Date.now() - start;
      log("info", `Done in ${time}ms`);
      return res;
    } catch (err) {
      log("error", `Handler failed: ${err.message}`);
      return errorResponse(err.message, 500);
    }
  },
};
// =================== IMAGE HANDLING ===================
async function handleImage(request, env, ctx, startTime) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  const bw = url.searchParams.get("bw") === "1";
  const userQ = parseInt(url.searchParams.get("l")) || 75;
  const jpeg = url.searchParams.get("jpg") === "1" || url.searchParams.get("jpeg") === "1";

  if (!isValidUrl(target)) return errorResponse("Invalid URL", 400);

  const quality = Math.max(CONFIG.MIN_QUALITY, Math.min(100, userQ));
  log("info", `→ Fetching ${target} | q=${quality}${bw ? " bw" : ""}`);

  const wsrvParams = new URLSearchParams({
    url: target,
    q: quality.toString(),
    output: jpeg ? "jpg" : "webp",
  });
  if (bw) wsrvParams.set("il", "");

  const wsrvUrl = `https://wsrv.nl/?${wsrvParams.toString()}`;
  const browserUA = "Mozilla/5.0 (Android 14) Chrome/125 Mobile Safari/537.36";
  const cacheKey = new Request(`v4-${btoa(target).slice(0, 40)}-q${quality}-${jpeg ? "jpg" : "webp"}`);
  const cache = caches.default;

  // --- ETag client cache ---
  const clientTag = request.headers.get("if-none-match");
  const cached = await cache.match(cacheKey);
  if (cached && clientTag && cached.headers.get("etag") === clientTag) {
    log("cache", "Client ETag HIT");
    return new Response(null, { status: 304 });
  }

  if (cached) {
    log("cache", "Cache HIT");
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, "HIT", quality);
  }

  // --- Dedup ---
  return await fetchWithDedup(cacheKey, async () => {
    const [wsrvRes, directRes] = await Promise.allSettled([
      fetchWithTimeout(wsrvUrl, { headers: { "User-Agent": browserUA } }, CONFIG.WS_TIMEOUT),
      fetchWithTimeout(target, { headers: { "User-Agent": browserUA } }, CONFIG.WS_TIMEOUT * 2),
    ]);

    let res = null;
    if (wsrvRes.status === "fulfilled" && wsrvRes.value.ok && isImage(wsrvRes.value)) {
      res = wsrvRes.value;
    } else if (directRes.status === "fulfilled" && directRes.value.ok && isImage(directRes.value)) {
      log("warn", "Fallback: wsrv failed, using direct");
      res = directRes.value;
    }

    if (!res) throw new Error("All fetch attempts failed");

    // --- Skip small images ---
    const len = parseInt(res.headers.get("content-length") || "0");
    if (len > 0 && len < CONFIG.SMALL_IMG_SKIP) {
      log("warn", "Skipping small image (<50KB)");
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      await updateStats(env, { requests: 1, cacheMisses: 1 });
      return addHeaders(res, startTime, "MISS-SMALL", quality);
    }

    // --- Stream & save ---
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    await updateStats(env, { requests: 1, cacheMisses: 1 });
    return addHeaders(res, startTime, "MISS", quality);
  });
}
// =================== UTILITIES ===================
function isImage(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.startsWith("image/") && !ct.includes("html");
}

function isValidUrl(link) {
  try {
    const u = new URL(link);
    const bad =
      ["localhost", "127.", "192.168.", "10.", "172."].some((p) => u.hostname.startsWith(p)) ||
      !["http:", "https:"].includes(u.protocol);
    return !bad;
  } catch {
    return false;
  }
}

// Dedup + auto-cleanup
async function fetchWithDedup(cacheKey, fn) {
  const key = cacheKey.url;
  if (pendingRequests.has(key)) {
    log("info", "🕓 Waiting on in-flight fetch...");
    return pendingRequests.get(key);
  }

  const p = fn().finally(() => {
    setTimeout(() => pendingRequests.delete(key), dedupTTL);
  });
  pendingRequests.set(key, p);
  return p;
}

async function fetchWithTimeout(url, opts, ms) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

// Adaptive TTL (extend for repeated cache hits)
function adaptiveTTL(hits) {
  if (hits > 50) return CONFIG.CACHE_TTL_MAX;
  if (hits > 10) return 3600; // 1h
  return CONFIG.CACHE_TTL_MIN;
}

// =================== STATS ===================
async function updateStats(env, delta) {
  for (const key in delta) localStats[key] += delta[key] || 0;

  if (Date.now() - lastFlushTime < CONFIG.KV_FLUSH_INTERVAL) return;
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
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, compressed: 0, errors: 0 };
    lastFlushTime = Date.now();
    log("cache", "KV flushed successfully");
  } catch (err) {
    log("error", "KV update failed: " + err.message);
  }
}

// =================== CORS + UI ===================
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
  return new Response(JSON.stringify({ error: msg, status }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function addHeaders(res, start, cache, q) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Cache-Control", `public, max-age=${adaptiveTTL(localStats.cacheHits)}`);
  h.set("ETag", h.get("etag") || `"v4-${Date.now()}"`);
  h.set("X-Cache-Status", cache);
  h.set("X-Quality", q.toString());
  h.set("X-Response-Time", `${Date.now() - start}ms`);
  return new Response(res.body, { status: res.status, headers: h });
}

function getWebInterface() {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚡ Bandwidth Hero Proxy v4</h2>
      <p>Use: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
      <p>Stats: <a href="/stats">/stats</a></p>
      <p>Reset: <a href="/reset">/reset</a></p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

async function showStatsPage(env) {
  const s = (await env.KV_STATS.get("stats", { type: "json" })) || {};
  const saved = (s.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate = s.requests ? ((s.cacheHits / s.requests) * 100).toFixed(1) : 0;
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h1>📊 Bandwidth Hero Stats</h1>
      <p>Total: ${s.requests || 0}</p>
      <p>Hits: ${s.cacheHits || 0} (${hitRate}%)</p>
      <p>Misses: ${s.cacheMisses || 0}</p>
      <p>Saved: ${saved} MB</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
