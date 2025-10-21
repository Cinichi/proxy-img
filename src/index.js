// Bandwidth Hero v3.7 — Auto-Fix Edition
// Safe for Cloudflare Free Plan: decoding, parallel fetch race, referer spoof, throttling, adaptive retries.

// ========== GLOBALS ==========
let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();
const pendingRequests = new Map(); // dedup per-instance
const DEDUP_CLEAN_INTERVAL = 10_000;
const DEDUP_ENTRY_TTL = 15_000;

// Throttler: limit concurrent outgoing fetches (protect Free Plan subrequest cap)
const MAX_CONCURRENT_FETCHES = 18; // conservative under CF Free
let activeFetches = 0;
const fetchQueue = [];

// Dedup cleanup to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingRequests.entries()) {
    if (now - v.start > DEDUP_ENTRY_TTL) pendingRequests.delete(k);
  }
}, DEDUP_CLEAN_INTERVAL);

// ========== HELPERS: logging, CORS, errors ==========
function shortKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.split('/').pop().slice(0, 15)}`;
  } catch {
    return url.slice(0, 20);
  }
}
function log(level, ...args) {
  // minimal structured-ish logging; keep off on non-debug runs to save CPU
  if (args.debug) {
    console[level](...args.msg ? [args.msg, ...(args.data ? [args.data] : [])] : args);
  } else {
    // only errors and warnings when not debug
    if (level === 'error' || level === 'warn') console[level](...args);
  }
}
function logError(context, err, target) {
  try {
    console.error(`❌ [${context}]`, err && err.message ? err.message : err, target || '');
  } catch (e) {
    /* ignore logging errors */
  }
}
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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

// Prevent SSRF — block private / localhost ranges
function isPrivateHost(host) {
  if (!host) return true;
  return (
    /(localhost|\.local$)/i.test(host) ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host) ||
    /^(::1|fc00:|fe80:)/i.test(host)
  );
}

// ETag generation (stable short)
function getETag(key) {
  try {
    return '"' + btoa(key).slice(0, 12) + '"';
  } catch {
    return `"etag-${Date.now()}"`;
  }
}

// ========== ENTRY ==========

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

    const targetParam = url.searchParams.get('url');
    if (!targetParam) return getWebInterface();

    // decode potential double-encoded URLs (fixes many wsrv 404s)
    let targetUrl;
    try {
      // Try one decode, but only if it looks encoded
      targetUrl = targetParam.includes('%') ? decodeURIComponent(targetParam) : targetParam;
    } catch (err) {
      // fallback to raw
      targetUrl = targetParam;
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return errorResponse('Invalid target URL', 400);
    }

    if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
      return errorResponse('Invalid or private URL', 400);
    }

    const debug = url.searchParams.get('debug') === '1';
    const jpeg = url.searchParams.get('jpg') === '1' || url.searchParams.get('jpeg') === '1';
    const bw = url.searchParams.get('bw') === '1';
    const qualityParam = url.searchParams.get('l');
    const qualityRequested = Math.min(100, Math.max(1, parseInt(qualityParam) || 0)); // 0 = auto

    const etag = getETag(targetUrl);
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Access-Control-Allow-Origin': '*' } });
    }

    try {
      return await handleImageRequest({
        targetUrl,
        parsed,
        env,
        ctx,
        startTime,
        debug,
        jpeg,
        bw,
        qualityRequested,
        etag,
      });
    } catch (err) {
      logError('Worker', err, targetUrl);
      return errorResponse(`Internal error: ${err.message || err}`, 500);
    }
  },
};

// ========== CORE IMAGE HANDLING ==========

async function handleImageRequest(opts) {
  const { targetUrl, parsed, env, ctx, startTime, debug, jpeg, bw, qualityRequested, etag } = opts;
  const cache = caches.default;

  // Build base wsrv url builder using adaptive q logic below
  function buildWsrvUrl(q) {
    const params = new URLSearchParams({
      url: targetUrl,
      q: String(q),
      output: jpeg ? 'jpg' : 'webp',
    });
    if (bw) params.set('il', '');
    return `https://wsrv.nl/?${params.toString()}`;
  }

  // choose cacheKey that includes modifiers
  const cacheKey = new Request(`${targetUrl}-q${qualityRequested || 'auto'}-${jpeg ? 'jpg' : 'webp'}-${bw ? 'bw' : 'nobw'}`);

  // fast cache check
  const cached = await cache.match(cacheKey);
  if (cached) {
    if (debug) console.log('✅ [CACHE HIT]', shortKey(targetUrl));
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, 'HIT', qualityRequested || 'auto', buildWsrvUrl(qualityRequested || 'auto'), etag);
  }

  // dedup wrapper
  return await fetchWithDedup(cacheKey, async () => {
    // Try series of attempts with adaptive quality fallback
    const qualityList = qualityRequested && qualityRequested > 0 ? [qualityRequested] : [80, 65, 50];

    let finalResponse = null;
    let finalUsedWsrv = false;
    let finalQualityUsed = qualityList[0];

    for (const q of qualityList) {
      const wsrvUrl = buildWsrvUrl(q);
      const browserUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

      // Options for fetches
      const wsrvOpts = { headers: { 'User-Agent': browserUA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }, cf: { cacheEverything: true } };
      // Spoof referer to the origin of the target — helps many CDNs that require referer
      const referer = parsed.origin + '/';
      const directOpts = { headers: { 'User-Agent': browserUA, Referer: referer, Accept: 'image/*,*/*;q=0.8' }, cf: { cacheEverything: true } };

      // Use throttled fetch wrapper to respect MAX_CONCURRENT_FETCHES
      const wsrvPromise = throttledFetch(() => fetchWithTimeout(wsrvUrl, wsrvOpts, 8000));
      const directPromise = throttledFetch(() => fetchWithTimeout(targetUrl, directOpts, 10000));

      // Race both — but require image content-type. Implement small helper that rejects non-image.
      const safeImage = (p) =>
        p.then((res) => {
          if (!res) throw new Error('No response');
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (!res.ok || !ct.startsWith('image/')) throw new Error(`Not-image (${res.status} ${ct})`);
          return res;
        });

      // Try to get the first valid image from wsrv or direct
      try {
        finalResponse = await Promise.any([safeImage(wsrvPromise), safeImage(directPromise)]);
        // Determine which succeeded (compare URLs)
        const urlUsed = finalResponse.url || '';
        finalUsedWsrv = urlUsed.includes('wsrv.nl');
        finalQualityUsed = q;
        if (debug) console.log(`🏁 [RACE] used ${finalUsedWsrv ? 'wsrv' : 'direct'} q=${q} ${shortKey(targetUrl)}`);
        break;
      } catch (raceErr) {
        // both failed for this quality; try next (lower) quality
        if (debug) console.warn(`[RACE FAILED] q=${q} ${shortKey(targetUrl)} -> ${raceErr && raceErr.message ? raceErr.message : raceErr}`);
        // continue to next quality
      }
    } // end for qualityList

    // If still no response, try a final direct-only attempt without wsrv (longer timeout)
    if (!finalResponse) {
      try {
        finalResponse = await throttledFetch(() =>
          fetchWithTimeout(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: parsed.origin + '/' }, cf: { cacheEverything: true } }, 12000)
        );
        const ct = (finalResponse.headers.get('content-type') || '').toLowerCase();
        if (!finalResponse.ok || !ct.startsWith('image/')) {
          throw new Error(`Direct fetch failed final (${finalResponse.status} ${ct})`);
        }
        finalUsedWsrv = false;
      } catch (err) {
        logError('Final Direct Fetch', err, targetUrl);
        return errorResponse('Failed to fetch image', 502);
      }
    }

    // Validate content-type once more
    const contentType = (finalResponse.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      if (debug) console.warn(`[BAD CONTENT-TYPE] ${contentType} ${shortKey(targetUrl)}`);
      return errorResponse('Invalid image content-type', 502);
    }

    // Determine size (if available)
    const size = parseInt(finalResponse.headers.get('content-length') || '0');
    const estimatedOriginal = size > 0 ? Math.round(size * 1.65) : 0;
    const bytesSaved = size > 0 && finalUsedWsrv ? Math.max(0, estimatedOriginal - size) : 0;
    if (bytesSaved > 0) {
      // safe update bytes saved metric
      localStats.bytesSaved += bytesSaved;
    }

    // Skip caching tiny images to avoid cache churn
    if (size > 0 && size < 10_000) {
      await updateStats(env, { requests: 1, cacheMisses: 1 });
      if (debug) console.log('↩️ Small image, skipping cache', shortKey(targetUrl));
      return addHeaders(finalResponse, startTime, 'MISS-SMALL', finalQualityUsed, finalUsedWsrv ? 'wsrv' : targetUrl, etag);
    }

    // Prepare cached clone with adaptive TTL
    const ttl = size > 500_000 ? 86_400 : 604_800; // large=1d, small=7d
    const cloneForCache = finalResponse.clone();
    const cacheHeaders = new Headers(cloneForCache.headers);
    cacheHeaders.set('Cache-Control', `public, max-age=${ttl}, immutable`);

    const toCache = new Response(cloneForCache.body, { status: cloneForCache.status, statusText: cloneForCache.statusText, headers: cacheHeaders });

    // Async cache put — don't block the response to client
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

    await updateStats(env, { requests: 1, cacheMisses: 1, bytesSaved });

    // Return streaming response immediately
    return addHeaders(finalResponse, startTime, finalUsedWsrv ? 'MISS-WSRV' : 'MISS-DIRECT', finalQualityUsed, finalUsedWsrv ? 'wsrv' : targetUrl, etag);
  });
}

// ========== DEDUP + THROTTLED FETCH HELPERS ==========

async function fetchWithDedup(cacheKey, fn) {
  const key = cacheKey.url;
  if (pendingRequests.has(key)) {
    const existing = pendingRequests.get(key);
    // wait existing promise
    try {
      return await existing.promise;
    } catch (e) {
      // if previous failed, proceed with new
    }
  }

  // create wrapper
  let resolveWrap, rejectWrap;
  const p = new Promise((res, rej) => {
    resolveWrap = res;
    rejectWrap = rej;
  });

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

function throttledFetch(fn) {
  // Returns a promise that executes `fn` when a slot is free
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeFetches++;
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        activeFetches--;
        // process next queued
        if (fetchQueue.length > 0) {
          const next = fetchQueue.shift();
          next();
        }
      }
    };

    if (activeFetches < MAX_CONCURRENT_FETCHES) {
      run();
    } else {
      // enqueue
      fetchQueue.push(run);
    }
  });
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms)),
  ]);
}

// ========== RESP HEADER / UI / STATS ==========

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

function getWebInterface() {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px">
      <h2>⚡ Bandwidth Hero Proxy v3.7</h2>
      <p>Use: <code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0</code></p>
      <p>Stats: <a href="/stats">/stats</a></p>
      <p>Debug: add <code>&debug=1</code></p>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function updateStats(env, delta) {
  for (const k in delta) localStats[k] = (localStats[k] || 0) + (delta[k] || 0);
  // batch KV writes every 15 minutes (reduce KV contention and request cost)
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;
  try {
    const kvData = (await env.KV_STATS.get('stats', { type: 'json' })) || {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesSaved: 0,
      lastReset: new Date().toISOString(),
    };
    for (const k in localStats) kvData[k] = (kvData[k] || 0) + (localStats[k] || 0);
    await env.KV_STATS.put('stats', JSON.stringify(kvData));
    // minimal console—avoid logging at scale
    // console.log(`📊 [KV] flushed stats: ${JSON.stringify(localStats)}`);
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    logError('KV Update', err);
  }
}

async function showStatsPage(env) {
  const stats = (await env.KV_STATS.get('stats', { type: 'json' })) || {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bytesSaved: 0,
    lastReset: 'N/A',
  };
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate = stats.requests > 0 ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) : 0;
  return new Response(
    `<!DOCTYPE html><html><head><title>📊 Bandwidth Hero Stats</title></head><body style="font-family:sans-serif;padding:40px">
      <h1>📊 Bandwidth Hero v3.7</h1>
      <p>Total: ${stats.requests}</p>
      <p>Cache Hits: ${stats.cacheHits} (${hitRate}%)</p>
      <p>Misses: ${stats.cacheMisses}</p>
      <p>Saved: ${savedMB} MB</p>
      <p>Last Reset: ${stats.lastReset}</p>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
