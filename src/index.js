// 🚀 Bandwidth Hero Cloudflare Worker v5.0 (No KV)
// ✅ Dual compression proxy: weserv.nl + wsrv.nl
// ✅ Auto JPEG retry for "image too large"
// ✅ Mask fallback for blocked CDNs
// ✅ Smart referer mapping for manga sites
// ✅ Works with Tachiyomi / Bandwidth Hero

const MASK_PROXY = "https://proxy-img.zoro1.workers.dev/"; // Your secondary proxy
const CACHE_TTL = 604800; // 7 days
const DEFAULT_QUALITY = 75;

const PROXIES = [
  { name: "weserv.nl", url: "https://images.weserv.nl/" },
  { name: "wsrv.nl", url: "https://wsrv.nl/" },
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134 Safari/537.36",
  "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
};

// ======================
// 🔧 REFERER DETECTION
// ======================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // 🔹 Mangabuddy numbered CDNs (auto-detect chapter)
  if (/^s\d+\.mbcdnsa[a-z]\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    return match
      ? `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`
      : "https://mangabuddy.com/";
  }

  // 🔹 Likemanga + all mirror CDNs
  if (
    host.includes("likemanga.ink") ||
    host.includes("1stkmgv1.com") ||
    host.includes("1kmgv") ||
    host.includes("like1.")
  ) {
    return "https://likemanga.ink/";
  }

  // 🔹 Backup & other manga mirrors
  const map = {
    mgcdn: "https://res.mgcdn.xyz/",
    mbbcdn: "https://res.mgcdn.xyz/",
    mangapill: "https://mangapill.com/",
    readdetectiveconan: "https://mangapill.com/",
    hentaifox: "https://hentaifox.com/",
    nhentai: "https://nhentai.net/",
  };

  for (const [key, ref] of Object.entries(map)) {
    if (host.includes(key)) return ref;
  }

  // Default fallback — use same host as referer
  return `https://${hostname}/`;
}

// ======================
// ⚙️ MAIN HANDLER
// ======================
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleCORS();

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return infoPage();

    const bw = url.searchParams.get("bw") === "1";
    const jpeg = url.searchParams.get("jpg") === "1";
    const quality = Math.min(100, Math.max(1, parseInt(url.searchParams.get("l")) || DEFAULT_QUALITY));
    const debug = url.searchParams.get("debug") === "1";

    const parsed = new URL(targetUrl);
    const referer = getRefererForHost(parsed.hostname, targetUrl);
    const cache = caches.default;
    const cacheKey = new Request(`${targetUrl}-${quality}-${jpeg}-${bw}`);

    // 🧠 Cache Check
    const cached = await cache.match(cacheKey);
    if (cached) return addHeaders(cached, "HIT", quality);

    // 🟢 Try normal compression
    let response = await tryCompressionProxies(targetUrl, referer, quality, jpeg, bw, debug);
    let method = response?.method || "none";

    // 🟡 Try masked compression if failed
    if (!response?.ok) {
      if (debug) console.log("🟡 Normal failed, trying masked...");
      const maskedUrl = `${MASK_PROXY}?url=${encodeURIComponent(targetUrl)}&mask=1`;
      response = await tryCompressionProxies(maskedUrl, referer, quality, jpeg, bw, debug, true);
      method = "masked";
    }

    // 🔴 Final fallback: direct fetch
    if (!response?.ok) {
      if (debug) console.log("🔴 Compression failed — fetching direct");
      response = await fetchDirect(targetUrl, referer);
      method = "direct";
    }

    if (!isImage(response)) return new Response(`{"error":"Failed"}`, { status: 502 });

    // 🗃️ Cache it
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return addHeaders(response, `MISS-${method}`, quality);
  },
};

// ======================
// 🖼️ TRY COMPRESSION
// ======================
async function tryCompressionProxies(targetUrl, referer, quality, jpeg, bw, debug) {
  for (const proxy of PROXIES) {
    const format = jpeg ? "jpg" : "webp";
    const qs = `url=${encodeURIComponent(targetUrl)}&q=${quality}&output=${format}${bw ? "&il" : ""}`;
    const proxyUrl = `${proxy.url}?${qs}`;

    try {
      const res = await fetch(proxyUrl, {
        headers: { ...HEADERS, Referer: referer },
        cf: { cacheEverything: true, cacheTtl: CACHE_TTL },
      });

      if (isImage(res)) {
        res.method = proxy.name;
        if (debug) console.log(`✅ ${proxy.name} success`);
        return res;
      }

      const text = await res.clone().text();
      if (text.includes("image too large") && !jpeg) {
        if (debug) console.log(`🟠 ${proxy.name}: too large → retry JPEG`);
        const retryUrl = `${proxy.url}?url=${encodeURIComponent(targetUrl)}&q=${quality}&output=jpg`;
        const retry = await fetch(retryUrl, {
          headers: { ...HEADERS, Referer: referer },
          cf: { cacheEverything: true, cacheTtl: CACHE_TTL },
        });
        if (isImage(retry)) {
          retry.method = `${proxy.name}-jpeg`;
          return retry;
        }
      }
    } catch (e) {
      if (debug) console.log(`❌ ${proxy.name} error: ${e.message}`);
    }
  }
  return null;
}

// ======================
// 🔁 DIRECT FETCH
// ======================
async function fetchDirect(url, referer) {
  const refs = [referer, "https://mangabuddy.com/", "https://likemanga.ink/", "https://manganato.com/"];
  for (const ref of refs) {
    try {
      const res = await fetch(url, { headers: { ...HEADERS, Referer: ref } });
      if (isImage(res)) return res;
    } catch {}
  }
  return new Response("Fetch failed", { status: 502 });
}

// ======================
// 🧩 HELPERS
// ======================
function isImage(res) {
  const ct = res.headers.get("content-type") || "";
  return res.ok && ct.startsWith("image/");
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

function addHeaders(response, cache, quality) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=604800");
  headers.set("X-Cache-Status", cache);
  headers.set("X-Quality", quality.toString());
  return new Response(response.body, { status: response.status, headers });
}

function infoPage() {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
<h2>⚡ Bandwidth Hero Proxy v5.0</h2>
<p>Usage: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
<ul>
<li>Dual compression proxy (weserv.nl + wsrv.nl)</li>
<li>Mask fallback for blocked sites</li>
<li>Auto JPEG retry if WebP too large</li>
<li>Smart referer detection</li>
</ul>
</body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
