// 🚀 Bandwidth Hero v3.7 — Cloudflare Safe Version
// ✅ No global async/timers
// ✅ Fixes Cloudflare Pages deploy error
// ✅ KV-safe stats, Tachiyomi optimized

// =================== GLOBALS ===================
let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();
const pendingRequests = new Map();
const DEDUP_ENTRY_TTL = 15000;
const MAX_CONCURRENT_FETCHES = 18;
let activeFetches = 0;
const fetchQueue = [];

// We'll trigger dedup cleanup only inside handler now.
function cleanupDedup() {
  const now = Date.now();
  for (const [k, v] of pendingRequests.entries()) {
    if (now - v.start > DEDUP_ENTRY_TTL) pendingRequests.delete(k);
  }
}

// =================== HELPERS ===================
function shortKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.split('/').pop().slice(0, 15)}`;
  } catch {
    return url ? url.slice(0, 20) : 'unknown';
  }
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function errorResponse(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg, status }), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function makeETag(key) {
  try {
    const hash = Array.from(key).reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0) | 0, 0);
    return `"${Math.abs(hash).toString(36)}"`;
  } catch {
    return `"etag-${Date.now()}"`;
  }
}

function isPrivateHost(host) {
  if (!host) return true;
  const lower = host.toLowerCase();
  return /(localhost|\.local$)/i.test(lower) ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host) ||
    /^(::1|fc00:|fe80:)/i.test(host);
}
// =================== ENTRY POINT ===================
export default {
  async fetch(request, env, ctx) {
    cleanupDedup(); // ✅ cleanup moved here
    const startTime = Date.now();
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCORS();
    if (url.pathname === '/stats') return await showStatsPage(env);
    if (url.pathname === '/reset') {
      await env.KV_STATS.delete('stats');
      return new Response('✅ Stats reset.', {
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeFetches,
        pendingRequests: pendingRequests.size,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    const target = url.searchParams.get('url');
    if (!target) return getWebInterface();

    // Validate & normalize URL
    let parsed;
    try { parsed = new URL(decodeURIComponent(target)); }
    catch { return errorResponse('Invalid URL', 400); }

    if (!/^https?:$/.test(parsed.protocol)) return errorResponse('Invalid protocol', 400);
    if (isPrivateHost(parsed.hostname)) return errorResponse('Private host blocked', 403);

    const etag = makeETag(target);
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { 'ETag': etag } });
    }

    const jpeg = url.searchParams.get('jpg') === '1';
    const bw = url.searchParams.get('bw') === '1';
    const q = Math.min(100, Math.max(1, parseInt(url.searchParams.get('l')) || 75));

    try {
      const res = await handleImageRequest(parsed.href, { jpeg, bw, q, etag, env, ctx, startTime });
      return res;
    } catch (err) {
      console.error('❌ Image error:', err);
      return errorResponse('Image fetch failed: ' + err.message, 500);
    }
  }
};

// =================== IMAGE HANDLING ===================
async function handleImageRequest(targetUrl, { jpeg, bw, q, etag, env, ctx, startTime }) {
  const cache = caches.default;
  const cacheKey = new Request(`${targetUrl}?q=${q}&${jpeg ? 'jpg' : 'webp'}${bw ? '&bw' : ''}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, 'HIT', q, etag);
  }

  // Race Weserv + Direct
  const wsrvUrl = `https://wsrv.nl/?url=${encodeURIComponent(targetUrl)}&q=${q}&output=${jpeg ? 'jpg' : 'webp'}${bw ? '&il' : ''}`;
  const res = await Promise.any([
    fetchWithTimeout(wsrvUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000),
    fetchWithTimeout(targetUrl, { headers: { 'Referer': parsedOrigin(targetUrl) } }, 10000),
  ]);

  if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/'))
    throw new Error('Invalid image response');

  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  await updateStats(env, { requests: 1, cacheMisses: 1 });
  return addHeaders(res, startTime, 'MISS', q, etag);
}

function parsedOrigin(url) {
  try { return new URL(url).origin + '/'; } catch { return '/'; }
}
// =================== FETCH UTILITIES ===================
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function addHeaders(response, startTime, cacheStatus, quality, etag) {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Cache-Control', 'public, max-age=604800, immutable');
  h.set('X-Cache-Status', cacheStatus);
  h.set('X-Response-Time', `${Date.now() - startTime}ms`);
  h.set('X-Quality', quality);
  h.set('ETag', etag);
  return new Response(response.body, { status: response.status, headers: h });
}

// =================== KV STATS ===================
async function updateStats(env, delta) {
  for (const k in delta) localStats[k] += delta[k] || 0;
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;
  try {
    const kv = (await env.KV_STATS.get('stats', { type: 'json' })) || {
      requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0,
    };
    for (const k in localStats) kv[k] += localStats[k];
    await env.KV_STATS.put('stats', JSON.stringify(kv));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (e) { console.error('KV update failed:', e); }
}

// =================== UI ===================
function getWebInterface() {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚡ Bandwidth Hero Proxy v3.7</h2>
      <p>Use: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
      <p>Stats: <a href="/stats">/stats</a> | Reset: <a href="/reset">/reset</a></p>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}

async function showStatsPage(env) {
  const s = (await env.KV_STATS.get('stats', { type: 'json' })) || {};
  const saved = (s.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate = s.requests ? ((s.cacheHits / s.requests) * 100).toFixed(1) : 0;
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h1>📊 Stats</h1>
      <p>Requests: ${s.requests || 0}</p>
      <p>Cache Hits: ${s.cacheHits || 0} (${hitRate}%)</p>
      <p>Misses: ${s.cacheMisses || 0}</p>
      <p>Saved: ${saved} MB</p>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}
