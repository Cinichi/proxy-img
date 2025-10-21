// Bandwidth Hero v3.6 — Free Plan + Cookies + 403-bypass (images.weserv.nl)
// Deploy with Wrangler. Bind a KV namespace as `KV_STATS` in worker bindings.

// =================== GLOBALS ===================
let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();
const pendingRequests = new Map();
const DEDUP_CLEAN_INTERVAL = 10_000;
const DEDUP_ENTRY_TTL = 15_000;

// Throttler conservative for CF Free Plan
const MAX_CONCURRENT_FETCHES = 18;
let activeFetches = 0;
const fetchQueue = [];

// Dedup cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingRequests.entries()) {
    if (now - v.start > DEDUP_ENTRY_TTL) pendingRequests.delete(k);
  }
}, DEDUP_CLEAN_INTERVAL);

// =================== HELPERS: Logging / CORS / Cookies / Utils ===================
function shortKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.split('/').pop().slice(0, 15)}`;
  } catch {
    return url ? url.slice(0, 20) : 'unknown';
  }
}
function debugLog(debug, ...args) {
  if (debug) console.log(...args);
}
function warnLog(...args) { console.warn(...args); }
function errorLog(...args) { console.error(...args); }

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}
function errorResponse(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg, status }), {
    status,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  });
}

// Cookie helpers
function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const name = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try { cookies[name] = decodeURIComponent(val); } catch { cookies[name] = val; }
  });
  return cookies;
}
function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(String(value))}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(Number(opts.maxAge))}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.secure) parts.push('Secure');
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}
function setCookieHeader(headers, name, value, opts = {}) {
  headers.append('Set-Cookie', serializeCookie(name, value, opts));
}

// SSRF protection
function isPrivateHost(host) {
  if (!host) return true;
  return /(localhost|\.local$)/i.test(host) ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host) ||
    /^(::1|fc00:|fe80:)/i.test(host);
}

// ETag helper
function makeETag(key) {
  try { return '"' + btoa(key).slice(0, 12) + '"'; } catch { return `"etag-${Date.now()}"`; }
}

// =================== ENTRY POINT ===================
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCORS();
    if (url.pathname === '/stats') return await showStatsPage(env);
    if (url.pathname === '/reset') {
      await env.KV_STATS.delete('stats');
      return new Response('✅ Stats reset.', { headers: { 'Content-Type': 'text/plain' } });
    }

    // Cookies: create session_id if missing
    const cookies = parseCookies(request);
    let sessionId = cookies.session_id;
    const cookieHeaders = new Headers();
    if (!sessionId) {
      sessionId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // not HttpOnly so client can read if needed; change httpOnly:true for server-only
      setCookieHeader(cookieHeaders, 'session_id', sessionId, { maxAge: 60 * 60 * 24 * 30, path: '/', secure: true, httpOnly: false, sameSite: 'Lax' });
      debugLog(url.searchParams.get('debug') === '1', '🍪 [COOKIE] New session:', sessionId);
    } else {
      debugLog(url.searchParams.get('debug') === '1', '🍪 [COOKIE] Existing session:', sessionId);
    }

    // require ?url
    const raw = url.searchParams.get('url');
    if (!raw) {
      const web = getWebInterface();
      // attach cookie headers to HTML response
      for (const [k, v] of cookieHeaders.entries()) web.headers.append(k, v);
      return web;
    }

    // decode once to avoid wsrv 404 on double-encoded URLs
    let targetUrl;
    try { targetUrl = raw.includes('%') ? decodeURIComponent(raw) : raw; } catch { targetUrl = raw; }

    // validate url
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return errorResponse('Invalid URL', 400); }
    if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) return errorResponse('Invalid or private URL', 400);

    // prepare etag
    const etag = makeETag(targetUrl);
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Access-Control-Allow-Origin': '*' } });
    }

    // prepare options
    const debug = url.searchParams.get('debug') === '1';
    const jpeg = url.searchParams.get('jpg') === '1' || url.searchParams.get('jpeg') === '1';
    const bw = url.searchParams.get('bw') === '1';
    const qualityParam = url.searchParams.get('l');
    const qualityRequested = Math.min(100, Math.max(1, parseInt(qualityParam) || 0)); // 0 => auto

    try {
      const response = await handleImageRequest({
        targetUrl, parsed, env, ctx, startTime, debug, jpeg, bw, qualityRequested, etag, sessionId
      });

      // attach cookie header(s) to response
      const merged = new Headers(response.headers);
      for (const [k, v] of cookieHeaders.entries()) merged.append(k, v);
      return new Response(response.body, { status: response.status, headers: merged });
    } catch (err) {
      errorLog('Worker', err, targetUrl);
      return errorResponse(`Internal error: ${err && err.message ? err.message : err}`, 500);
    }
  }
};

// =================== CORE: Image handling ===================
async function handleImageRequest(opts) {
  const { targetUrl, parsed, env, ctx, startTime, debug, jpeg, bw, qualityRequested } = opts;
  const cache = caches.default;

  function buildWsrvUrl(wsrvBase, q) {
    // wsrvBase already includes base proxy host; encode target properly
    const params = new URLSearchParams();
    params.set('url', encodeURIComponent(targetUrl)); // encode for upstream proxies
    params.set('q', String(q));
    params.set('output', jpeg ? 'jpg' : 'webp');
    if (bw) params.set('il', '');
    // images.weserv.nl likes plain url param; we encode target into param value
    return `${wsrvBase}?${params.toString()}`;
  }

  // cache key must include modifiers
  const cacheKey = new Request(`${targetUrl}-q${qualityRequested || 'auto'}-${jpeg ? 'jpg' : 'webp'}-${bw ? 'bw' : 'nobw'}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    debugLog(debug, '✅ [CACHE HIT]', shortKey(targetUrl));
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, 'HIT', qualityRequested || 'auto', 'cache', makeETag(targetUrl));
  }

  // Dedup wrapper
  return await fetchWithDedup(cacheKey, async () => {
    // Adaptive quality list: prefer requested then fallbacks
    const qualityList = (qualityRequested && qualityRequested > 0) ? [qualityRequested] : [80, 65, 50];

    // proxies to try (images.weserv.nl first — bypass CF block)
    const proxyCandidates = [
      'https://images.weserv.nl/', // recommended first (bypass many CF origin blocks)
      'https://wsrv.nl/'           // secondary (may be blocked sometimes)
    ];
    // for direct origin fallback we use targetUrl

    let finalResponse = null;
    let finalUsed = 'direct';
    let finalQ = qualityList[0];

    for (const q of qualityList) {
      finalQ = q;
      // prepare promises (throttled)
      const attempts = [];

      // try proxies first
      for (const base of proxyCandidates) {
        const urlProxy = buildWsrvUrl(base, q);
        const browserUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
        const opts = { headers: { 'User-Agent': browserUA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }, cf: { cacheEverything: true } };
        attempts.push(throttledFetch(() => fetchWithTimeout(urlProxy, opts, 9000)));
      }

      // direct attempt with referer spoof (origin + /)
      const referer = parsed.origin + '/';
      const directOpts = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
          'Referer': referer,
          'Accept': 'image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        cf: { cacheEverything: true },
      };
      attempts.push(throttledFetch(() => fetchWithTimeout(targetUrl, directOpts, 10000)));

      // Validate helper: returns image Response or rejects
      const safe = p => p.then(res => {
        if (!res) throw new Error('No response');
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (!res.ok || !ct.startsWith('image/')) throw new Error(`Not-image (${res.status} ${ct})`);
        return res;
      });

      // race: first successful image among attempts
      try {
        // emulate Promise.any: run all attempts and pick first that resolves the safe wrapper
        const resolved = await promiseAny(attempts.map(safe));
        finalResponse = resolved;
        // determine used source
        const usedUrl = finalResponse.url || '';
        if (usedUrl.includes('images.weserv.nl')) finalUsed = 'weserv';
        else if (usedUrl.includes('wsrv.nl')) finalUsed = 'wsrv';
        else finalUsed = 'direct';
        debugLog(debug, `🏁 [RACE] used ${finalUsed} q=${q} ${shortKey(targetUrl)}`);
        break;
      } catch (raceErr) {
        debugLog(debug, `[RACE FAILED] q=${q} ${shortKey(targetUrl)} -> ${raceErr && raceErr.message ? raceErr.message : raceErr}`);
        // try next quality
      }
    } // end qualityList loop

    // final fallback: if still no valid response, return 502
    if (!finalResponse) {
      errorLog('Final fetch failed', shortKey(targetUrl));
      return errorResponse('Failed to fetch image', 502);
    }

    // validate content-type/size
    const contentType = (finalResponse.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) return errorResponse('Invalid image content-type', 502);
    const size = parseInt(finalResponse.headers.get('content-length') || '0');
    const estimatedOriginal = size > 0 ? Math.round(size * 1.7) : 0;
    const bytesSaved = size > 0 && finalUsed !== 'direct' ? Math.max(0, estimatedOriginal - size) : 0;
    if (bytesSaved > 0) localStats.bytesSaved += bytesSaved;

    // Small image skip caching
    if (size > 0 && size < 10_000) {
      await updateStats(env, { requests: 1, cacheMisses: 1 });
      debugLog(debug, '↩️ Small image, skipping cache', shortKey(targetUrl));
      return addHeaders(finalResponse, startTime, 'MISS-SMALL', finalQ, finalUsed, makeETag(targetUrl));
    }

    // Adaptive TTL and async cache put
    const ttl = size > 500_000 ? 86_400 : 604_800;
    const cloneForCache = finalResponse.clone();
    const cacheHeaders = new Headers(cloneForCache.headers);
    cacheHeaders.set('Cache-Control', `public, max-age=${ttl}, immutable`);
    const toCache = new Response(cloneForCache.body, { status: cloneForCache.status, statusText: cloneForCache.statusText, headers: cacheHeaders });

    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    await updateStats(env, { requests: 1, cacheMisses: 1 });

    return addHeaders(finalResponse, startTime, finalUsed === 'direct' ? 'MISS-DIRECT' : 'MISS-PROXY', finalQ, finalUsed, makeETag(targetUrl));
  });
}

// =================== FETCH UTILITIES ===================
async function fetchWithDedup(cacheKey, fn) {
  const key = cacheKey.url;
  if (pendingRequests.has(key)) {
    const existing = pendingRequests.get(key);
    try { return await existing.promise; } catch (e) { /* fallthrough to start new */ }
  }
  let resolveWrap, rejectWrap;
  const p = new Promise((res, rej) => { resolveWrap = res; rejectWrap = rej; });
  const entry = { promise: p, start: Date.now() };
  pendingRequests.set(key, entry);

  (async () => {
    try {
      const result = await fn();
      resolveWrap(result);
    } catch (err) {
      rejectWrap(err);
    } finally {
      pendingRequests.delete(key);
    }
  })();

  return await p;
}

// throttledFetch to stay under concurrent subrequest cap
function throttledFetch(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeFetches++;
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        activeFetches--;
        if (fetchQueue.length > 0) {
          const next = fetchQueue.shift();
          next();
        }
      }
    };
    if (activeFetches < MAX_CONCURRENT_FETCHES) run();
    else fetchQueue.push(run);
  });
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  return Promise.race([ fetch(url, options), new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), ms)) ]);
}

// Promise.any-like helper with better error messaging
async function promiseAny(promises) {
  return new Promise((resolve, reject) => {
    let rejections = 0;
    const errors = [];
    promises.forEach(p => {
      p.then(resolve).catch(err => {
        rejections++;
        errors.push(err && err.message ? err.message : String(err));
        if (rejections === promises.length) reject(new Error(errors.join(' | ')));
      });
    });
  });
}

// =================== RESPONSE HANDLING / STATS ===================
function addHeaders(response, startTime, cacheStatus, quality, wsrvUrl, etag) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'public, max-age=604800, immutable');
  headers.set('X-Cache-Status', cacheStatus);
  headers.set('X-Quality', String(quality));
  headers.set('X-WSRV', String(wsrvUrl));
  headers.set('X-Response-Time', `${Date.now() - startTime}ms`);
  if (etag) headers.set('ETag', etag);
  return new Response(response.body, { status: response.status, headers });
}

async function updateStats(env, delta) {
  for (const k in delta) localStats[k] = (localStats[k] || 0) + (delta[k] || 0);
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return; // 15 min batching
  try {
    const kvData = (await env.KV_STATS.get('stats', { type: 'json' })) || {
      requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, lastReset: new Date().toISOString()
    };
    for (const k in localStats) kvData[k] = (kvData[k] || 0) + (localStats[k] || 0);
    await env.KV_STATS.put('stats', JSON.stringify(kvData));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    errorLog('KV Update', err);
  }
}

async function showStatsPage(env) {
  const stats = (await env.KV_STATS.get('stats', { type: 'json' })) || { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, lastReset: 'N/A' };
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate = stats.requests ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) : 0;
  return new Response(
`<!DOCTYPE html><html><head><title>📊 Bandwidth Hero Stats</title></head><body style="font-family:sans-serif;padding:40px">
  <h1>📊 Bandwidth Hero v3.6</h1>
  <p>Total: ${stats.requests}</p>
  <p>Cache Hits: ${stats.cacheHits} (${hitRate}%)</p>
  <p>Misses: ${stats.cacheMisses}</p>
  <p>Saved: ${savedMB} MB</p>
  <p>Last Reset: ${stats.lastReset}</p>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function getWebInterface() {
  return new Response(`<html><body style="font-family:sans-serif;padding:40px">
    <h2>⚡ Bandwidth Hero Proxy v3.6</h2>
    <p>Use: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
    <p>Stats: <a href="/stats">/stats</a> | Reset: <a href="/reset">/reset</a></p>
    <p>Debug: add <code>&debug=1</code></p>
  </body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
