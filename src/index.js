// Bandwidth Hero v3.6 — Enhanced version with fixes
// Deploy with Wrangler. Bind a KV namespace as `KV_STATS` in worker bindings.

// =================== GLOBALS ===================
let localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
let lastFlushTime = Date.now();
const pendingRequests = new Map();
const DEDUP_CLEAN_INTERVAL = 10_000;
const DEDUP_ENTRY_TTL = 15_000;

const MAX_CONCURRENT_FETCHES = 18;
let activeFetches = 0;
const fetchQueue = [];

// Cleanup interval - only runs on Worker keep-alive
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingRequests.entries()) {
      if (now - v.start > DEDUP_ENTRY_TTL) pendingRequests.delete(k);
    }
  }, DEDUP_CLEAN_INTERVAL);
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

function debugLog(debug, ...args) {
  if (debug) console.log(...args);
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
      'Cache-Control': 'no-store'
    },
  });
}

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

function isPrivateHost(host) {
  if (!host) return true;
  const lower = host.toLowerCase();
  return /(localhost|\.local$)/i.test(lower) ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host) ||
    /^(::1|fc00:|fe80:)/i.test(host);
}

function makeETag(key) {
  try { 
    // More robust ETag generation
    const hash = Array.from(key).reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0) | 0, 0);
    return `"${Math.abs(hash).toString(36)}"`;
  } catch { 
    return `"etag-${Date.now()}"`; 
  }
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
      return new Response('✅ Stats reset.', { 
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } 
      });
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        activeFetches,
        pendingRequests: pendingRequests.size
      }), { 
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } 
      });
    }

    // Cookie handling
    const cookies = parseCookies(request);
    let sessionId = cookies.session_id;
    const cookieHeaders = new Headers();
    
    if (!sessionId) {
      sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setCookieHeader(cookieHeaders, 'session_id', sessionId, { 
        maxAge: 60 * 60 * 24 * 30, 
        path: '/', 
        secure: true, 
        httpOnly: false, 
        sameSite: 'Lax' 
      });
      debugLog(url.searchParams.get('debug') === '1', '🍪 [COOKIE] New session:', sessionId);
    }

    const raw = url.searchParams.get('url');
    if (!raw) {
      const web = getWebInterface();
      for (const [k, v] of cookieHeaders.entries()) web.headers.append(k, v);
      return web;
    }

    // Decode URL safely
    let targetUrl;
    try { 
      targetUrl = raw.includes('%') ? decodeURIComponent(raw) : raw; 
    } catch { 
      targetUrl = raw; 
    }

    // Validate URL
    let parsed;
    try { 
      parsed = new URL(targetUrl); 
    } catch { 
      return errorResponse('Invalid URL format', 400); 
    }
    
    if (!/^https?:$/.test(parsed.protocol)) {
      return errorResponse('Only HTTP/HTTPS protocols allowed', 400);
    }
    
    if (isPrivateHost(parsed.hostname)) {
      return errorResponse('Private/local URLs not allowed', 403);
    }

    const etag = makeETag(targetUrl);
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { 
        status: 304, 
        headers: { 
          ETag: etag, 
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=604800'
        } 
      });
    }

    const debug = url.searchParams.get('debug') === '1';
    const jpeg = url.searchParams.get('jpg') === '1' || url.searchParams.get('jpeg') === '1';
    const bw = url.searchParams.get('bw') === '1';
    const qualityParam = url.searchParams.get('l');
    const qualityRequested = Math.min(100, Math.max(1, parseInt(qualityParam) || 0));

    try {
      const response = await handleImageRequest({
        targetUrl, parsed, env, ctx, startTime, debug, jpeg, bw, 
        qualityRequested, etag, sessionId
      });

      const merged = new Headers(response.headers);
      for (const [k, v] of cookieHeaders.entries()) merged.append(k, v);
      
      return new Response(response.body, { status: response.status, headers: merged });
    } catch (err) {
      console.error('Worker error:', err, targetUrl);
      return errorResponse(`Internal error: ${err?.message || String(err)}`, 500);
    }
  }
};

// =================== IMAGE HANDLING ===================
async function handleImageRequest(opts) {
  const { targetUrl, parsed, env, ctx, startTime, debug, jpeg, bw, qualityRequested, etag } = opts;
  const cache = caches.default;

  function buildWsrvUrl(wsrvBase, q) {
    const params = new URLSearchParams();
    // Don't double-encode - weserv handles raw URLs
    params.set('url', targetUrl);
    params.set('q', String(q));
    params.set('output', jpeg ? 'jpg' : 'webp');
    if (bw) params.set('il', '');
    params.set('default', targetUrl); // fallback if fetch fails
    return `${wsrvBase}?${params.toString()}`;
  }

  // More specific cache key
  const modifiers = `q${qualityRequested || 'auto'}-${jpeg ? 'jpg' : 'webp'}-${bw ? 'bw' : 'nobw'}`;
  const cacheKeyUrl = `${targetUrl}##${modifiers}`;
  const cacheKey = new Request(cacheKeyUrl);
  
  const cached = await cache.match(cacheKey);
  if (cached) {
    debugLog(debug, '✅ [CACHE HIT]', shortKey(targetUrl));
    await updateStats(env, { requests: 1, cacheHits: 1 });
    return addHeaders(cached, startTime, 'HIT', qualityRequested || 'auto', 'cache', etag);
  }

  return await fetchWithDedup(cacheKey, async () => {
    const qualityList = (qualityRequested && qualityRequested > 0) 
      ? [qualityRequested] 
      : [80, 65, 50];

    const proxyCandidates = [
      'https://images.weserv.nl/',
      'https://wsrv.nl/'
    ];

    let finalResponse = null;
    let finalUsed = 'direct';
    let finalQ = qualityList[0];

    for (const q of qualityList) {
      finalQ = q;
      const attempts = [];

      // Proxy attempts
      for (const base of proxyCandidates) {
        const urlProxy = buildWsrvUrl(base, q);
        const opts = { 
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
          }, 
          cf: { cacheEverything: true, cacheTtl: 604800 }
        };
        attempts.push(throttledFetch(() => fetchWithTimeout(urlProxy, opts, 9000)));
      }

      // Direct fetch with anti-blocking headers
      const referer = `${parsed.origin}/`;
      const directOpts = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': referer,
          'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
        },
        cf: { cacheEverything: true, cacheTtl: 604800 },
      };
      attempts.push(throttledFetch(() => fetchWithTimeout(targetUrl, directOpts, 10000)));

      const safe = p => p.then(res => {
        if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 'failed'}`);
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('image/')) throw new Error(`Not image: ${ct}`);
        return res;
      });

      try {
        const resolved = await promiseAny(attempts.map(safe));
        finalResponse = resolved;
        
        const usedUrl = finalResponse.url || '';
        if (usedUrl.includes('images.weserv.nl')) finalUsed = 'weserv';
        else if (usedUrl.includes('wsrv.nl')) finalUsed = 'wsrv';
        else finalUsed = 'direct';
        
        debugLog(debug, `🏁 [SUCCESS] ${finalUsed} q=${q} ${shortKey(targetUrl)}`);
        break;
      } catch (raceErr) {
        debugLog(debug, `[ATTEMPT FAILED] q=${q} ${shortKey(targetUrl)} -> ${raceErr?.message}`);
      }
    }

    if (!finalResponse) {
      console.error('All fetch attempts failed:', shortKey(targetUrl));
      return errorResponse('Failed to fetch image from all sources', 502);
    }

    const contentType = (finalResponse.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('image/')) {
      return errorResponse('Invalid content-type received', 502);
    }

    const size = parseInt(finalResponse.headers.get('content-length') || '0');
    const estimatedOriginal = size > 0 ? Math.round(size * 1.7) : 0;
    const bytesSaved = size > 0 && finalUsed !== 'direct' ? Math.max(0, estimatedOriginal - size) : 0;
    
    if (bytesSaved > 0) localStats.bytesSaved += bytesSaved;

    // Skip caching small images
    if (size > 0 && size < 10_000) {
      await updateStats(env, { requests: 1, cacheMisses: 1 });
      debugLog(debug, '↩️ Small image, no cache', shortKey(targetUrl));
      return addHeaders(finalResponse, startTime, 'MISS-SMALL', finalQ, finalUsed, etag);
    }

    // Adaptive TTL
    const ttl = size > 500_000 ? 86_400 : 604_800;
    const cloneForCache = finalResponse.clone();
    const cacheHeaders = new Headers(cloneForCache.headers);
    cacheHeaders.set('Cache-Control', `public, max-age=${ttl}, immutable`);
    
    const toCache = new Response(cloneForCache.body, { 
      status: cloneForCache.status, 
      statusText: cloneForCache.statusText, 
      headers: cacheHeaders 
    });

    ctx.waitUntil(cache.put(cacheKey, toCache));
    await updateStats(env, { requests: 1, cacheMisses: 1 });

    return addHeaders(
      finalResponse, 
      startTime, 
      finalUsed === 'direct' ? 'MISS-DIRECT' : 'MISS-PROXY', 
      finalQ, 
      finalUsed, 
      etag
    );
  });
}

// =================== FETCH UTILITIES ===================
async function fetchWithDedup(cacheKey, fn) {
  const key = cacheKey.url;
  if (pendingRequests.has(key)) {
    const existing = pendingRequests.get(key);
    try { return await existing.promise; } 
    catch { /* start new fetch */ }
  }
  
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
    
    if (activeFetches < MAX_CONCURRENT_FETCHES) {
      run();
    } else {
      fetchQueue.push(run);
    }
  });
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function promiseAny(promises) {
  return new Promise((resolve, reject) => {
    let rejections = 0;
    const errors = [];
    
    promises.forEach((p, i) => {
      p.then(resolve).catch(err => {
        rejections++;
        errors.push(`[${i}]: ${err?.message || String(err)}`);
        if (rejections === promises.length) {
          reject(new Error(`All failed: ${errors.join(' | ')}`));
        }
      });
    });
  });
}

// =================== RESPONSE & STATS ===================
function addHeaders(response, startTime, cacheStatus, quality, source, etag) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', 'X-Cache-Status,X-Quality,X-Source,X-Response-Time');
  
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=604800, immutable');
  }
  
  headers.set('X-Cache-Status', cacheStatus);
  headers.set('X-Quality', String(quality));
  headers.set('X-Source', String(source));
  headers.set('X-Response-Time', `${Date.now() - startTime}ms`);
  
  if (etag) headers.set('ETag', etag);
  
  return new Response(response.body, { status: response.status, headers });
}

async function updateStats(env, delta) {
  for (const k in delta) {
    localStats[k] = (localStats[k] || 0) + (delta[k] || 0);
  }
  
  // Flush every 15 minutes
  if (Date.now() - lastFlushTime < 15 * 60 * 1000) return;
  
  try {
    const kvData = (await env.KV_STATS.get('stats', { type: 'json' })) || {
      requests: 0, 
      cacheHits: 0, 
      cacheMisses: 0, 
      bytesSaved: 0, 
      lastReset: new Date().toISOString()
    };
    
    for (const k in localStats) {
      kvData[k] = (kvData[k] || 0) + (localStats[k] || 0);
    }
    
    await env.KV_STATS.put('stats', JSON.stringify(kvData));
    localStats = { requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0 };
    lastFlushTime = Date.now();
  } catch (err) {
    console.error('KV stats update failed:', err);
  }
}

async function showStatsPage(env) {
  const stats = (await env.KV_STATS.get('stats', { type: 'json' })) || { 
    requests: 0, cacheHits: 0, cacheMisses: 0, bytesSaved: 0, lastReset: 'N/A' 
  };
  
  const savedMB = (stats.bytesSaved / (1024 * 1024)).toFixed(2);
  const hitRate = stats.requests ? ((stats.cacheHits / stats.requests) * 100).toFixed(1) : 0;
  
  return new Response(
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>📊 Bandwidth Hero Stats</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 40px; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; }
    .stat { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee; }
    .stat:last-child { border-bottom: none; }
    .label { color: #666; }
    .value { font-weight: 600; color: #0066cc; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Bandwidth Hero v3.6</h1>
    <div class="stat"><span class="label">Total Requests:</span><span class="value">${stats.requests}</span></div>
    <div class="stat"><span class="label">Cache Hits:</span><span class="value">${stats.cacheHits} (${hitRate}%)</span></div>
    <div class="stat"><span class="label">Cache Misses:</span><span class="value">${stats.cacheMisses}</span></div>
    <div class="stat"><span class="label">Data Saved:</span><span class="value">${savedMB} MB</span></div>
    <div class="stat"><span class="label">Last Reset:</span><span class="value">${stats.lastReset}</span></div>
  </div>
</body>
</html>`, 
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function getWebInterface() {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚡ Bandwidth Hero Proxy</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 40px; background: #f5f5f5; }
    .container { max-width: 700px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h2 { color: #333; margin-bottom: 20px; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
    .usage { background: #f9f9f9; padding: 15px; border-radius: 4px; margin: 20px 0; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h2>⚡ Bandwidth Hero Proxy v3.6</h2>
    <div class="usage">
      <p><strong>Usage:</strong></p>
      <p><code>?url=&lt;IMAGE_URL&gt;&l=75&jpg=0&bw=0&debug=0</code></p>
      <p><strong>Parameters:</strong></p>
      <ul>
        <li><code>url</code> - Image URL (required)</li>
        <li><code>l</code> - Quality 1-100 (default: auto)</li>
        <li><code>jpg</code> - Force JPEG (default: WebP)</li>
        <li><code>bw</code> - Black & white</li>
        <li><code>debug</code> - Debug logging</li>
      </ul>
    </div>
    <p><strong>Links:</strong></p>
    <p>📊 <a href="/stats">View Statistics</a> | 🔄 <a href="/reset">Reset Stats</a> | 💚 <a href="/health">Health Check</a></p>
  </div>
</body>
</html>`, 
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
