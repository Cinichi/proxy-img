#!/usr/bin/env node
'use strict';

const os = require('os');

// ========================
// ⚙️ Config (everything overridable via env vars)
// ========================
const CPU = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

function envInt(name, def, min = 0) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min ? v : def;
}

// sharp, zlib and DNS all share libuv's threadpool, which defaults to only 4 threads.
// Must be set before the pool is first used, so this goes before everything else.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.min(64, Math.max(8, CPU * 2)));
}

const CONFIG = {
  PORT:              envInt('PORT', 4000, 1),
  MAX_CONCURRENT:    envInt('MAX_CONCURRENT', Math.max(2, CPU), 1),  // parallel sharp jobs
  SHARP_THREADS:     envInt('SHARP_THREADS', 1, 1),                  // libvips threads per image
  WEBP_EFFORT:       Math.min(6, envInt('WEBP_EFFORT', 4)),          // 0-6, auto-lowered under load
  CACHE_MAX_MB:      envInt('CACHE_MAX_MB', 256, 8),
  CACHE_TTL_MIN:     envInt('CACHE_TTL_MIN', 360, 1),
  FETCH_TIMEOUT:     envInt('FETCH_TIMEOUT_MS', 15000, 1000),
  FETCH_RETRIES:     envInt('FETCH_RETRIES', 2),
  MAX_INPUT_BYTES:   envInt('MAX_INPUT_MB', 40, 1) * 1024 * 1024,
  MIN_PROCESS_BYTES: envInt('MIN_PROCESS_KB', 10) * 1024,
  PNG_LOSSLESS_MAX_PIXELS: envInt('PNG_LOSSLESS_MAX_MP', 6) * 1e6,
  QUEUE_TIMEOUT:     envInt('QUEUE_TIMEOUT_MS', 30000, 1000),
  BLOCK_PRIVATE:     process.env.ALLOW_PRIVATE !== '1'               // SSRF guard
};

const WEBP_MAX_DIM = 16383;
const JPEG_MAX_DIM = 65500;
const PASSTHROUGH_RE = /^image\/(gif|svg\+xml|avif|heic|heif|x-icon|vnd\.microsoft\.icon)$/;

const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');

sharp.concurrency(CONFIG.SHARP_THREADS);
sharp.cache(false); // proxy images are one-offs, libvips op cache only wastes RAM

const PORT = CONFIG.PORT;
const PM2_LOG_PATH = `${os.homedir()}/.pm2/logs/hero-out.log`;
const PM2_LOG_LINES = 200;
const PM2_TAIL_BYTES = 128 * 1024;
const STATS_FILE = `${os.homedir()}/.pm2/bwhero-stats.json`;
const STATS_TMP = STATS_FILE + '.tmp';

const kb = n => (n / 1024).toFixed(1);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ========================
// 🧱 Building blocks
// ========================
class HttpError extends Error {
  constructor(status, msg) {
    super(msg || `HTTP ${status}`);
    this.status = status;
  }
}

function abortError() {
  const e = new Error('Aborted');
  e.code = 'ERR_CANCELED';
  return e;
}

function isAbort(e) {
  return !!e && (e.code === 'ERR_CANCELED' || e.name === 'AbortError' || axios.isCancel(e));
}

function isBlocked(e) {
  return !!e && (e.code === 'EBLOCKED' || (e.cause && e.cause.code === 'EBLOCKED') || /Blocked private/.test(e.message || ''));
}

function isRetryable(e) {
  const c = e && (e.code || (e.cause && e.cause.code));
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE', 'ECONNREFUSED'].includes(c);
}

// Proper semaphore: slot is handed straight to the next waiter (no race), supports timeout + abort
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  acquire(timeoutMs, signal) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (this.active < this.max) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = {};
      const remove = () => { const i = this.queue.indexOf(w); if (i !== -1) this.queue.splice(i, 1); };
      const cleanup = () => { clearTimeout(w.timer); if (signal) signal.removeEventListener('abort', w.onAbort); };
      w.resolve = () => { cleanup(); resolve(); };
      w.timer = setTimeout(() => {
        remove(); cleanup();
        const e = new Error('Queue timeout');
        e.code = 'EQUEUE';
        reject(e);
      }, timeoutMs);
      if (signal) {
        w.onAbort = () => { remove(); cleanup(); reject(abortError()); };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.queue.push(w);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) next.resolve(); // slot transferred, active count unchanged
    else this.active--;
  }
}

// LRU cache bounded by BYTES (not key count) with TTL
class ByteLRU {
  constructor(maxBytes, ttlMs) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.bytes = 0;
  }
  get size() { return this.map.size; }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.delete(key); return undefined; }
    this.map.delete(key);
    this.map.set(key, e); // bump to most-recent
    return e.value;
  }
  set(key, value) {
    const len = value.buf.length;
    if (len > this.maxBytes / 4) return false; // one huge image shouldn't evict everything
    this.delete(key);
    this.map.set(key, { value, len, exp: Date.now() + this.ttlMs });
    this.bytes += len;
    while (this.bytes > this.maxBytes && this.map.size) this.delete(this.map.keys().next().value);
    return true;
  }
  delete(key) {
    const e = this.map.get(key);
    if (e) { this.bytes -= e.len; this.map.delete(key); }
  }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.exp < now) this.delete(k);
  }
}

const sem = new Semaphore(CONFIG.MAX_CONCURRENT);
const cache = new ByteLRU(CONFIG.CACHE_MAX_MB * 1024 * 1024, CONFIG.CACHE_TTL_MIN * 60 * 1000);
setInterval(() => cache.sweep(), 5 * 60 * 1000).unref();

const inflight = new Map(); // cacheKey -> { promise, refs, ac }
const runtime = { procMs: 0, procCount: 0, coalesced: 0 };

// ========================
// 🌐 Networking: DNS cache, SSRF guard, keep-alive agents
// ========================
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) {
      const v4 = l.slice(7);
      return net.isIPv4(v4) ? isPrivateIp(v4) : true;
    }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

const dnsCache = new Map();
const DNS_TTL = 5 * 60 * 1000;

// Cached DNS lookups (CDNs get hit constantly) + blocks private/internal addresses
function cachedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options || {};
  const key = `${hostname}|${options.family || 0}|${options.all ? 1 : 0}|${options.hints || 0}`;
  const hit = dnsCache.get(key);
  if (hit && hit.exp > Date.now()) return process.nextTick(() => callback(null, ...hit.args));

  dns.lookup(hostname, options, (err, ...args) => {
    if (err) return callback(err);
    const list = options.all ? args[0] : [{ address: args[0] }];
    if (CONFIG.BLOCK_PRIVATE && list.some(a => isPrivateIp(a.address))) {
      const e = new Error(`Blocked private address: ${hostname}`);
      e.code = 'EBLOCKED';
      return callback(e);
    }
    dnsCache.set(key, { args, exp: Date.now() + DNS_TTL });
    if (dnsCache.size > 500) dnsCache.delete(dnsCache.keys().next().value);
    callback(null, ...args);
  });
}

const agentOpts = {
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 128,
  maxFreeSockets: 32,
  scheduling: 'lifo',
  lookup: cachedLookup
};
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchUpstream(url, headers, signal) {
  const base = {
    responseType: 'arraybuffer',
    timeout: CONFIG.FETCH_TIMEOUT,
    maxRedirects: 5,
    maxContentLength: CONFIG.MAX_INPUT_BYTES,
    maxBodyLength: CONFIG.MAX_INPUT_BYTES,
    validateStatus: () => true,
    httpAgent,
    httpsAgent,
    signal
  };
  const hostRoot = new URL(url).origin + '/';
  let lastErr;

  for (let attempt = 0; attempt <= CONFIG.FETCH_RETRIES; attempt++) {
    if (signal.aborted) throw abortError();
    try {
      let res = await axios.get(url, { ...base, headers });

      // Hotlink protection: try alternate referers
      if (res.status === 403) {
        const alts = [hostRoot, 'https://mangabuddy.com/'].filter(r => r !== headers.Referer);
        for (const ref of alts) {
          addLog(`🔁 403 RETRY | ${url}`);
          res = await axios.get(url, { ...base, headers: { ...headers, Referer: ref } });
          if (res.status !== 403) break;
        }
      }

      if ((res.status >= 500 || res.status === 429) && attempt < CONFIG.FETCH_RETRIES) {
        addLog(`🔁 RETRY ${attempt + 1} (HTTP ${res.status}) | ${url}`);
        await sleep(200 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (e) {
      if (isAbort(e) || isBlocked(e)) throw e;
      if (/maxContentLength|maxBodyLength/i.test(e.message || '')) throw new HttpError(413, 'Image too large');
      if (attempt >= CONFIG.FETCH_RETRIES || !isRetryable(e)) throw e;
      lastErr = e;
      addLog(`🔁 RETRY ${attempt + 1} (${e.code || e.message}) | ${url}`);
      await sleep(200 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ========================
// 📊 Stats (persisted)
// ========================
// IST = UTC+5:30
function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function getISTKey(type) {
  const d = nowIST();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  // ISO week
  const tmp = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const weekYear = tmp.getUTCFullYear();
  const weekNo = String(Math.ceil(((tmp - Date.UTC(weekYear, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0');
  if (type === 'week')  return `${weekYear}-W${weekNo}`;
  if (type === 'month') return `${y}-${m}`;
  if (type === 'year')  return `${y}`;
}

function emptyPeriod() {
  return { requests: 0, bytesSaved: 0, bytesReceived: 0, errors: 0 };
}

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      return {
        requests:           saved.requests           || 0,
        cacheHits:          saved.cacheHits          || 0,
        totalBytesSaved:    saved.totalBytesSaved    || 0,
        totalBytesReceived: saved.totalBytesReceived || 0,
        errors:             saved.errors             || 0,
        startTime:          saved.startTime          || Date.now(),
        periods:            saved.periods            || {}
      };
    }
  } catch (e) {}
  return { requests: 0, cacheHits: 0, totalBytesSaved: 0, totalBytesReceived: 0, errors: 0, startTime: Date.now(), periods: {} };
}

const stats = loadStats();

// Async + atomic (tmp file then rename) so a crash mid-write can't corrupt the stats
let savingStats = false;
function saveStats() {
  if (savingStats) return;
  savingStats = true;
  fs.promises.writeFile(STATS_TMP, JSON.stringify(stats), 'utf8')
    .then(() => fs.promises.rename(STATS_TMP, STATS_FILE))
    .catch(() => {})
    .finally(() => { savingStats = false; });
}

function saveStatsSync() {
  try {
    fs.writeFileSync(STATS_TMP, JSON.stringify(stats), 'utf8');
    fs.renameSync(STATS_TMP, STATS_FILE);
  } catch (e) {}
}

function recordPeriod(bytesSaved, bytesReceived, isError) {
  const keys = [getISTKey('week'), getISTKey('month'), getISTKey('year')];
  for (const key of keys) {
    if (!stats.periods[key]) stats.periods[key] = emptyPeriod();
    const p = stats.periods[key];
    if (!isError) {
      p.requests++;
      p.bytesSaved    += bytesSaved;
      p.bytesReceived += bytesReceived;
    } else {
      p.errors++;
    }
  }
  // Prune old periods (keep last 60 keys max)
  const allKeys = Object.keys(stats.periods);
  if (allKeys.length > 60) {
    allKeys.slice(0, allKeys.length - 60).forEach(k => delete stats.periods[k]);
  }
}

setInterval(saveStats, 60000).unref();

// ========================
// 📝 Live logs
// ========================
const liveLogs = { lines: [], maxLines: 300, clients: [] };
let clientSeq = 0;

function addLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  liveLogs.lines.push(line);
  if (liveLogs.lines.length > liveLogs.maxLines) liveLogs.lines.shift();
  if (!liveLogs.clients.length) return;
  const payload = `data: ${JSON.stringify({ message: line })}\n\n`;
  for (const c of liveLogs.clients) {
    try { c.res.write(payload); } catch (e) {}
  }
}

// SSE keep-alive so proxies don't drop idle log streams
setInterval(() => {
  for (const c of liveLogs.clients) {
    try { c.res.write(': ping\n\n'); } catch (e) {}
  }
}, 25000).unref();

// Only reads the tail of the pm2 log (the old version read the WHOLE file synchronously)
function readPm2Logs() {
  try {
    const fd = fs.openSync(PM2_LOG_PATH, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, PM2_TAIL_BYTES);
      if (len === 0) return [];
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (size > len) lines.shift(); // drop partial first line
      return lines.filter(l => l.trim()).slice(-PM2_LOG_LINES);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return [];
  }
}

// ========================
// 🔧 Referer rules
// ========================
function getRefererForHost(hostname, targetUrl = '') {
  const host = hostname.toLowerCase();

  if (/^s\d+\.mbcdns[a-z]{1,3}\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    return match
      ? `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`
      : 'https://mangabuddy.com/';
  }

  if (host.includes('qvzr')) return 'https://mangak.io/';

  if (host.includes('likemanga') || host.includes('1kmgv') || host.includes('like1.') || host.includes('mangayy') || host.includes('mgread')) {
    return 'https://likemanga.ink/';
  }

  const map = {
    mgcdn: 'https://res.mgcdn.xyz/',
    mbbcdn: 'https://res.mgcdn.xyz/',
    mangapill: 'https://mangapill.com/',
    readdetectiveconan: 'https://mangapill.com/',
    hentaifox: 'https://hentaifox.com/',
    nhentai: 'https://nhentai.net/',
    hentaicdn: 'https://hentalk.pw/'
  };

  for (const [k, v] of Object.entries(map)) {
    if (host.includes(k)) return v;
  }

  return `https://${hostname}/`;
}

// ========================
// 🖼️ Image pipeline
// ========================
function quickSkipReason(mime, size, { useJpeg, bw, width }) {
  if (PASSTHROUGH_RE.test(mime)) return 'passthrough type';
  const transforming = bw || width > 0;
  if (!transforming && size < CONFIG.MIN_PROCESS_BYTES) return 'tiny file';
  if (!transforming && useJpeg && /^image\/p?jpe?g$/.test(mime)) return 'JPEG passthrough';
  return null;
}

// Returns { buf, mime } on success, or { skip: reason } when the original should be served
async function transcode(input, mime, { quality, useJpeg, bw, width }) {
  const originalSize = input.length;

  // Adaptive quality/speed: when jobs are piling up, encode faster
  const backlog = sem.queue.length / sem.max;
  const busy = backlog > 0.5;
  const effort = Math.min(CONFIG.WEBP_EFFORT, backlog > 2 ? 1 : backlog > 1 ? 2 : backlog > 0.5 ? 3 : 6);

  try {
    let pipeline = sharp(input, { failOnError: false, sequentialRead: true, limitInputPixels: 268402689 });
    const meta = await pipeline.metadata(); // header only, cheap
    if ((meta.pages || 1) > 1) return { skip: 'animated' };

    const srcW = meta.width || 0;
    const srcH = meta.height || 0;
    let outW = srcW, outH = srcH, resized = false;

    if (width && srcW > width) {
      pipeline = pipeline.resize({ width, withoutEnlargement: true });
      outW = width;
      outH = Math.round(srcH * width / srcW);
      resized = true;
    }
    if (bw) pipeline = pipeline.grayscale();

    // WebP can't encode >16383px: tall webtoon strips go straight to JPEG (no wasted failed attempt)
    let wantJpeg = useJpeg;
    if (!wantJpeg && (outW > WEBP_MAX_DIM || outH > WEBP_MAX_DIM)) wantJpeg = true;
    if (outW > JPEG_MAX_DIM || outH > JPEG_MAX_DIM) return { skip: 'too large' };

    let out = null, outMime = null;

    if (!wantJpeg) {
      try {
        const isPng = mime.includes('png');
        if (isPng && !bw && outW * outH <= CONFIG.PNG_LOSSLESS_MAX_PIXELS) {
          // PNG source: lossless WebP first, near-lossless if that didn't help
          out = await pipeline.clone().webp({ lossless: true, effort }).toBuffer();
          if (out.length >= originalSize) {
            out = await pipeline.clone().webp({ nearLossless: true, quality: 85, effort }).toBuffer();
          }
        } else {
          const webpQuality = bw ? Math.max(65, quality - 15) : quality;
          out = await pipeline.clone().webp({
            quality: webpQuality,
            effort,
            smartSubsample: true,
            alphaQuality: 75
          }).toBuffer();
        }
        outMime = 'image/webp';
      } catch (webpErr) {
        addLog(`🔄 WEBP FAIL → JPEG | ${String(webpErr.message).slice(0, 60)}`);
        out = null;
      }
    }

    if (!out) {
      const jpegQuality = bw ? Math.max(60, quality - 20) : Math.max(65, quality - 15);
      let p = pipeline;
      if (meta.hasAlpha) p = p.flatten({ background: '#ffffff' }); // transparent → white, not black
      out = await p.jpeg({
        quality: jpegQuality,
        mozjpeg: !busy,                // mozjpeg is ~3-5x slower, skip it when backed up
        progressive: false,
        chromaSubsampling: '4:2:0',
        optimiseCoding: true,
        trellisQuantisation: !busy,
        overshootDeringing: !busy
      }).toBuffer();
      outMime = 'image/jpeg';
    }

    // Not worth the quality loss for <5% (unless the user asked for a resize / grayscale)
    const minGain = (resized || bw) ? 0 : 0.05;
    if (out.length >= originalSize || (originalSize - out.length) / originalSize < minGain) {
      return { skip: 'no-gain' };
    }
    return { buf: out, mime: outMime };
  } catch (err) {
    addLog(`⚠️ SHARP ERROR | ${err.message}`);
    return { skip: 'sharp-error' };
  }
}

// Does the full fetch → process → cache cycle once per unique request
async function produce(p, signal) {
  const { fetchUrl, parsed, key } = p;
  const headers = {
    'Referer': getRefererForHost(parsed.hostname, fetchUrl),
    'User-Agent': UA,
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  const t0 = Date.now();
  addLog(`🌐 FETCH | ${fetchUrl}`);
  const response = await fetchUpstream(fetchUrl, headers, signal);
  const networkTime = Date.now() - t0;

  if (response.status !== 200) {
    addLog(`❌ HTTP ${response.status} | ${fetchUrl}`);
    throw new HttpError(response.status);
  }

  const contentType = String(response.headers['content-type'] || '');
  if (!contentType.includes('image/')) {
    addLog(`❌ NOT IMAGE | ${fetchUrl}`);
    throw new HttpError(400, 'Not an image');
  }

  const input = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data); // no needless copy
  const originalSize = input.length;
  if (originalSize === 0) {
    addLog(`❌ EMPTY | ${fetchUrl}`);
    throw new HttpError(400, 'Empty image');
  }

  stats.requests++;
  stats.totalBytesReceived += originalSize;

  const mime = contentType.split(';')[0].trim().toLowerCase();
  let skipReason = quickSkipReason(mime, originalSize, p);
  let result = null;

  if (!skipReason) {
    await sem.acquire(CONFIG.QUEUE_TIMEOUT, signal);
    const t1 = Date.now();
    try {
      if (signal.aborted) throw abortError(); // client left while we were queued → skip the CPU work
      result = await transcode(input, mime, p);
    } finally {
      sem.release();
    }
    runtime.procMs += Date.now() - t1;
    runtime.procCount++;
    if (!result.buf) skipReason = result.skip;
  }

  const entry = result && result.buf
    ? { buf: result.buf, mime: result.mime, compressed: true, originalSize, saved: originalSize - result.buf.length }
    : { buf: input, mime, compressed: false, originalSize, saved: 0 };

  if (entry.compressed) stats.totalBytesSaved += entry.saved;
  recordPeriod(entry.saved, originalSize, false);
  if (!cache.set(key, entry)) addLog(`⚠️ CACHE SKIP | too large (${kb(entry.buf.length)}KB)`);

  const elapsed = Date.now() - t0;
  const procTime = elapsed - networkTime;
  const fmt = entry.mime.split('/')[1].split('+')[0].toUpperCase();
  const pct = entry.compressed ? ((1 - entry.buf.length / originalSize) * 100).toFixed(1) : '0.0';
  const status = entry.compressed ? '✅ COMPRESSED' : (skipReason === 'no-gain' || skipReason === 'sharp-error' ? '⚠️ ORIGINAL' : '⏭️ SKIP');
  const note = !entry.compressed && skipReason ? ` (${skipReason})` : '';
  const logLine = `${status}${note} | ${fmt} | ${kb(originalSize)}KB → ${kb(entry.buf.length)}KB (${pct}%) | net:${networkTime}ms proc:${procTime}ms | ${fetchUrl}`;
  console.log(logLine);
  addLog(logLine);

  return entry;
}

async function produceTracked(p, signal) {
  try {
    return await produce(p, signal);
  } catch (e) {
    if (!(e instanceof HttpError) && !isAbort(e)) {
      stats.errors++;
      recordPeriod(0, 0, true);
      const msg = `❌ ERROR | ${e.message}`;
      console.error(msg);
      addLog(msg);
    }
    throw e;
  }
}

// Identical concurrent requests share ONE fetch + encode (retries, prefetch, double-taps)
function getJob(key, params) {
  let job = inflight.get(key);
  if (!job) {
    const ac = new AbortController();
    job = { refs: 0, ac, promise: null };
    job.promise = produceTracked({ ...params, key }, ac.signal).finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
    job.promise.catch(() => {}); // avoid unhandled rejection if every client has left
    inflight.set(key, job);
  } else {
    runtime.coalesced++;
  }
  job.refs++;
  return job;
}

function sendImage(res, entry, cacheStatus, startTime) {
  res.writeHead(200, {
    'Content-Type': entry.mime,
    'Content-Length': entry.buf.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Cache-Status': cacheStatus,
    'X-Compression-Applied': entry.compressed ? 'yes' : 'no',
    'X-Original-Size': entry.originalSize,
    'X-Bytes-Saved': entry.saved,
    'X-Response-Time': `${Date.now() - startTime}ms`
  });
  res.end(entry.buf); // res.end skips express's per-response ETag hashing
}

// ========================
// 🚀 App
// ========================
const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// CORS first (was registered after the routes before, so it never ran)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function buildStatsJson() {
  const uptimeSec = Math.floor((Date.now() - stats.startTime) / 1000);
  return {
    requests: stats.requests,
    cacheHits: stats.cacheHits,
    errors: stats.errors,
    savedMB: (stats.totalBytesSaved / 1024 / 1024).toFixed(2),
    receivedMB: (stats.totalBytesReceived / 1024 / 1024).toFixed(2),
    savePercent: stats.totalBytesReceived > 0
      ? ((stats.totalBytesSaved / stats.totalBytesReceived) * 100).toFixed(1) : '0.0',
    hitRate: (stats.requests + stats.cacheHits) > 0
      ? ((stats.cacheHits / (stats.requests + stats.cacheHits)) * 100).toFixed(1) : '0.0',
    uptimeHr: (uptimeSec / 3600).toFixed(2),
    active: sem.active,
    max: sem.max,
    queued: sem.queue.length,
    inflight: inflight.size,
    coalesced: runtime.coalesced,
    avgProcMs: runtime.procCount ? Math.round(runtime.procMs / runtime.procCount) : 0,
    cacheKeys: cache.size,
    cacheItems: cache.size,
    cacheMB: (cache.bytes / 1024 / 1024).toFixed(1),
    cacheMaxMB: CONFIG.CACHE_MAX_MB,
    istTime: nowIST().toISOString().replace('T', ' ').slice(0, 19) + ' IST',
    periods: {
      week:  stats.periods[getISTKey('week')]  || emptyPeriod(),
      month: stats.periods[getISTKey('month')] || emptyPeriod(),
      year:  stats.periods[getISTKey('year')]  || emptyPeriod(),
      weekKey:  getISTKey('week'),
      monthKey: getISTKey('month'),
      yearKey:  getISTKey('year')
    }
  };
}

// ========================
// 📊 Dashboard
// ========================
app.get('/dashboard', (req, res) => {
  const s = buildStatsJson();
  const ttlLabel = CONFIG.CACHE_TTL_MIN >= 60
    ? `${(CONFIG.CACHE_TTL_MIN / 60).toFixed(1).replace(/\.0$/, '')}h`
    : `${CONFIG.CACHE_TTL_MIN}m`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bandwidth Hero</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{
      --bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;
      --accent:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#eab308;
      --text:#e2e8f0;--muted:#64748b;--mono:'JetBrains Mono',monospace
    }
    body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
    .topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:56px;position:sticky;top:0;z-index:100}
    .logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    .nav{display:flex;gap:4px}
    .nav-btn{background:transparent;border:none;color:var(--muted);padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;transition:.15s}
    .nav-btn:hover,.nav-btn.active{background:var(--border);color:var(--text)}
    .page{display:none;padding:24px;max-width:900px;margin:0 auto}
    .page.active{display:block}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
    .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
    .stat-card .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
    .stat-card .value{font-size:22px;font-weight:700;font-family:var(--mono);color:var(--text)}
    .stat-card .sub{font-size:11px;color:var(--muted);margin-top:4px}
    .stat-card.green .value{color:var(--green)}
    .stat-card.accent .value{color:var(--accent)}
    .stat-card.yellow .value{color:var(--yellow)}
    .stat-card.red .value{color:var(--red)}
    .section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
    .section h3{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px}
    .row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)}
    .row:last-child{border-bottom:none}
    .row .k{font-size:13px;color:var(--muted)}
    .row .v{font-size:13px;font-family:var(--mono);color:var(--text)}
    .bar-wrap{background:var(--bg);border-radius:4px;height:6px;margin-top:10px;overflow:hidden}
    .bar{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent),var(--green));transition:width .5s}
    .log-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
    .log-btn{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:7px;cursor:pointer;font-size:12px;font-family:inherit;transition:.15s}
    .log-btn:hover{background:var(--border)}
    .log-stream{background:#0a0c10;border:1px solid var(--border);border-radius:10px;height:60vh;overflow-y:auto;padding:14px;font-family:var(--mono);font-size:12px;line-height:1.7}
    .log-line{word-break:break-all}
    .ok{color:#22c55e}.err{color:#ef4444}.warn{color:#eab308}.fetch{color:#60a5fa}.cache{color:#a78bfa}.def{color:#94a3b8}
    .conn-badge{padding:4px 10px;border-radius:20px;font-size:11px;font-family:var(--mono)}
    .conn-on{background:#14532d;color:#4ade80}.conn-off{background:#450a0a;color:#f87171}
    .period-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);padding:5px 12px;border-radius:20px;cursor:pointer;font-size:12px;font-family:inherit}
    .period-btn.active{background:var(--accent);border-color:var(--accent);color:white}
    .health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
    .health-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;text-align:center}
    .health-card .icon{font-size:26px;margin-bottom:8px}
    .health-card .hval{font-size:20px;font-weight:700;font-family:var(--mono)}
    .health-card .hlabel{font-size:12px;color:var(--muted);margin-top:4px}
    @media(max-width:480px){.grid{grid-template-columns:1fr 1fr}.page{padding:14px}.log-stream{height:55vh}}
  </style>
</head>
<body>
<div class="topbar">
  <div class="logo"><div class="dot"></div>Bandwidth Hero</div>
  <nav class="nav">
    <button class="nav-btn active" onclick="showPage('stats',this)">📊 Stats</button>
    <button class="nav-btn" onclick="showPage('logs',this)">📋 Logs</button>
    <button class="nav-btn" onclick="showPage('health',this)">❤️ Health</button>
    <button class="nav-btn" onclick="location.href='/refcheck'">🧪 Referer</button>
  </nav>
</div>

<!-- STATS -->
<div id="page-stats" class="page active">
  <div class="grid">
    <div class="stat-card green">
      <div class="label">Saved</div>
      <div class="value" id="s-saved">${s.savedMB} MB</div>
      <div class="sub" id="s-pct">${s.savePercent}% reduction</div>
    </div>
    <div class="stat-card accent">
      <div class="label">Requests</div>
      <div class="value" id="s-req">${stats.requests.toLocaleString()}</div>
      <div class="sub">processed</div>
    </div>
    <div class="stat-card yellow">
      <div class="label">Cache Hits</div>
      <div class="value" id="s-hits">${stats.cacheHits.toLocaleString()}</div>
      <div class="sub" id="s-hitrate">${s.hitRate}% hit rate</div>
    </div>
    <div class="stat-card red">
      <div class="label">Errors</div>
      <div class="value" id="s-err">${stats.errors}</div>
      <div class="sub">&nbsp;</div>
    </div>
    <div class="stat-card">
      <div class="label">Received</div>
      <div class="value" id="s-recv">${s.receivedMB} MB</div>
      <div class="sub">from origin</div>
    </div>
    <div class="stat-card">
      <div class="label">Uptime</div>
      <div class="value" id="s-up">${s.uptimeHr}h</div>
      <div class="sub">&nbsp;</div>
    </div>
  </div>

  <div class="section">
    <h3>Concurrency</h3>
    <div class="row"><span class="k">Active / Max</span><span class="v" id="s-conc">${s.active} / ${s.max}</span></div>
    <div class="bar-wrap"><div class="bar" id="s-bar" style="width:${(s.active / s.max * 100).toFixed(0)}%"></div></div>
    <div class="row" style="margin-top:10px"><span class="k">Queued</span><span class="v" id="s-queue">${s.queued}</span></div>
    <div class="row"><span class="k">In-flight jobs</span><span class="v" id="s-infl">${s.inflight}</span></div>
    <div class="row"><span class="k">Coalesced requests</span><span class="v" id="s-coal">${s.coalesced}</span></div>
    <div class="row"><span class="k">Avg process time</span><span class="v" id="s-avg">${s.avgProcMs} ms</span></div>
    <div class="row"><span class="k">Cache</span><span class="v" id="s-ckeys">${s.cacheItems} items · ${s.cacheMB} / ${s.cacheMaxMB} MB</span></div>
  </div>

  <div class="section">
    <h3>📅 Period Stats <span id="ist-time" style="font-size:11px;color:var(--muted);font-weight:400;margin-left:8px"></span></h3>
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="period-btn active" onclick="setPeriod('week',this)">This Week</button>
      <button class="period-btn" onclick="setPeriod('month',this)">This Month</button>
      <button class="period-btn" onclick="setPeriod('year',this)">This Year</button>
    </div>
    <div class="row"><span class="k">Requests</span><span class="v" id="p-req">—</span></div>
    <div class="row"><span class="k">Data Saved</span><span class="v" id="p-saved">—</span></div>
    <div class="row"><span class="k">Data Received</span><span class="v" id="p-recv">—</span></div>
    <div class="row"><span class="k">Errors</span><span class="v" id="p-err">—</span></div>
    <div class="row"><span class="k">Period</span><span class="v" id="p-key">—</span></div>
  </div>

  <div class="section">
    <h3>Quick Setup</h3>
    <div class="row"><span class="k">WebP (browser)</span><span class="v">/?url=IMAGE_URL&l=80</span></div>
    <div class="row"><span class="k">JPEG (Tachiyomi)</span><span class="v">/?url=IMAGE_URL&jpg=1&l=80</span></div>
    <div class="row"><span class="k">Black & white</span><span class="v">/?url=IMAGE_URL&bw=1&l=75</span></div>
    <div class="row"><span class="k">Max width (px)</span><span class="v">/?url=IMAGE_URL&w=1080</span></div>
  </div>
</div>

<!-- LOGS -->
<div id="page-logs" class="page">
  <div class="log-toolbar">
    <button class="log-btn" onclick="clearLogs()">🗑 Clear</button>
    <button class="log-btn" onclick="scrollBottom()">⬇ Bottom</button>
    <button class="log-btn" id="as-btn" onclick="toggleAS()">🔒 Auto: ON</button>
    <button class="log-btn" onclick="exportLogs()">💾 Export</button>
    <span class="conn-badge conn-off" id="conn-badge">● Disconnected</span>
  </div>
  <div class="log-stream" id="log-stream">
    <div class="log-line def">Connecting...</div>
  </div>
</div>

<!-- HEALTH -->
<div id="page-health" class="page">
  <div class="health-grid">
    <div class="health-card">
      <div class="icon">🟢</div>
      <div class="hval" style="color:var(--green)">Online</div>
      <div class="hlabel">Status</div>
    </div>
    <div class="health-card">
      <div class="icon">⏱️</div>
      <div class="hval" id="h-up">${s.uptimeHr}h</div>
      <div class="hlabel">Uptime</div>
    </div>
    <div class="health-card">
      <div class="icon">⚡</div>
      <div class="hval">${s.max}</div>
      <div class="hlabel">Parallel jobs</div>
    </div>
    <div class="health-card">
      <div class="icon">🧠</div>
      <div class="hval" id="h-cache">${s.cacheItems}</div>
      <div class="hlabel">Cached items</div>
    </div>
    <div class="health-card">
      <div class="icon">🎯</div>
      <div class="hval">${CONFIG.WEBP_EFFORT}</div>
      <div class="hlabel">WebP effort (max, adaptive)</div>
    </div>
    <div class="health-card">
      <div class="icon">💾</div>
      <div class="hval">${ttlLabel}</div>
      <div class="hlabel">Cache TTL</div>
    </div>
  </div>
  <div class="section" style="margin-top:16px">
    <h3>Endpoints</h3>
    <div class="row"><span class="k">Image proxy</span><span class="v">GET /?url=</span></div>
    <div class="row"><span class="k">Dashboard</span><span class="v">GET /dashboard</span></div>
    <div class="row"><span class="k">Health JSON</span><span class="v">GET /health</span></div>
    <div class="row"><span class="k">Stats JSON</span><span class="v">GET /stats-json</span></div>
    <div class="row"><span class="k">Logs stream</span><span class="v">GET /logs/stream (SSE)</span></div>
  </div>

  <div class="section" style="margin-top:16px">
    <h3>Backup & Restore</h3>
    <div class="row">
      <span class="k">Download stats backup</span>
      <a href="/backup" download style="background:var(--accent);color:white;padding:6px 14px;border-radius:7px;font-size:12px;text-decoration:none;font-family:var(--mono)">⬇ Download</a>
    </div>
    <div class="row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <span class="k">Restore from backup</span>
      <div style="display:flex;gap:8px;width:100%">
        <input type="file" id="restore-file" accept=".json" style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px;border-radius:7px;font-size:12px">
        <button onclick="restoreBackup()" style="background:var(--green);color:#000;border:none;padding:6px 14px;border-radius:7px;font-size:12px;cursor:pointer;font-weight:600">↑ Restore</button>
      </div>
      <div id="restore-msg" style="font-size:12px;color:var(--muted)"></div>
    </div>
  </div>
</div>

<script>
  function showPage(name, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('page-' + name).classList.add('active');
    btn.classList.add('active');
    if (name === 'logs' && !window._sseInit) initSSE();
  }

  let currentPeriod = 'week';
  let lastPeriodData = null;

  function setPeriod(p, btn) {
    currentPeriod = p;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (lastPeriodData) updatePeriodUI(lastPeriodData);
  }

  function fmtMB(bytes) {
    const mb = bytes / 1024 / 1024;
    return mb >= 1000 ? (mb/1024).toFixed(2)+' GB' : mb.toFixed(2)+' MB';
  }

  function updatePeriodUI(d) {
    const p = d.periods[currentPeriod];
    document.getElementById('p-req').textContent   = Number(p.requests).toLocaleString();
    document.getElementById('p-saved').textContent = fmtMB(p.bytesSaved);
    document.getElementById('p-recv').textContent  = fmtMB(p.bytesReceived);
    document.getElementById('p-err').textContent   = p.errors;
    document.getElementById('p-key').textContent   = d.periods[currentPeriod + 'Key'] || '—';
  }

  // IST clock
  function updateISTClock() {
    const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const str = now.toISOString().replace('T',' ').slice(0,19) + ' IST';
    const el = document.getElementById('ist-time');
    if (el) el.textContent = str;
  }
  setInterval(updateISTClock, 1000);
  updateISTClock();

  async function refreshStats() {
    try {
      const d = await fetch('/stats-json').then(r => r.json());
      document.getElementById('s-saved').textContent = d.savedMB + ' MB';
      document.getElementById('s-pct').textContent = d.savePercent + '% reduction';
      document.getElementById('s-req').textContent = Number(d.requests).toLocaleString();
      document.getElementById('s-hits').textContent = Number(d.cacheHits).toLocaleString();
      document.getElementById('s-hitrate').textContent = d.hitRate + '% hit rate';
      document.getElementById('s-err').textContent = d.errors;
      document.getElementById('s-recv').textContent = d.receivedMB + ' MB';
      document.getElementById('s-up').textContent = d.uptimeHr + 'h';
      document.getElementById('s-conc').textContent = d.active + ' / ' + d.max;
      document.getElementById('s-bar').style.width = (d.active / d.max * 100) + '%';
      document.getElementById('s-queue').textContent = d.queued;
      document.getElementById('s-infl').textContent = d.inflight;
      document.getElementById('s-coal').textContent = d.coalesced;
      document.getElementById('s-avg').textContent = d.avgProcMs + ' ms';
      document.getElementById('s-ckeys').textContent = d.cacheItems + ' items · ' + d.cacheMB + ' / ' + d.cacheMaxMB + ' MB';
      document.getElementById('h-up').textContent = d.uptimeHr + 'h';
      document.getElementById('h-cache').textContent = d.cacheItems;
      if (d.periods) { lastPeriodData = d; updatePeriodUI(d); }
    } catch(e) {}
  }
  setInterval(refreshStats, 5000);
  refreshStats();

  let autoScroll = true;
  const stream = document.getElementById('log-stream');

  function classify(m) {
    if (m.includes('✅') || m.includes('COMPRESSED')) return 'ok';
    if (m.includes('❌') || m.includes('ERROR') || m.includes('BLOCKED')) return 'err';
    if (m.includes('⚠️') || m.includes('ORIGINAL') || m.includes('SKIP') || m.includes('QUEUED') || m.includes('RETRY')) return 'warn';
    if (m.includes('🌐') || m.includes('FETCH')) return 'fetch';
    if (m.includes('💜') || m.includes('CACHE')) return 'cache';
    return 'def';
  }

  function addLine(msg) {
    const d = document.createElement('div');
    d.className = 'log-line ' + classify(msg);
    d.textContent = msg;
    stream.appendChild(d);
    while (stream.children.length > 500) stream.removeChild(stream.firstChild);
    if (autoScroll) scrollBottom();
  }

  function initSSE() {
    window._sseInit = true;
    const badge = document.getElementById('conn-badge');
    const es = new EventSource('/logs/stream');
    es.onopen = () => { badge.textContent = '● Connected'; badge.className = 'conn-badge conn-on'; };
    es.onmessage = e => addLine(JSON.parse(e.data).message);
    es.onerror = () => { badge.textContent = '● Reconnecting...'; badge.className = 'conn-badge conn-off'; };
  }

  function scrollBottom() { stream.scrollTop = stream.scrollHeight; }
  function clearLogs() { stream.innerHTML = ''; }
  function toggleAS() {
    autoScroll = !autoScroll;
    document.getElementById('as-btn').textContent = autoScroll ? '🔒 Auto: ON' : '🔓 Auto: OFF';
  }
  async function restoreBackup() {
    const file = document.getElementById('restore-file').files[0];
    const msg = document.getElementById('restore-msg');
    if (!file) { msg.textContent = '⚠️ Select a backup file first'; msg.style.color = 'var(--yellow)'; return; }
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const r = await fetch('/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json)
      });
      const result = await r.json();
      if (result.ok) {
        msg.textContent = '✅ Restored successfully! Refreshing...';
        msg.style.color = 'var(--green)';
        setTimeout(() => location.reload(), 1500);
      } else {
        msg.textContent = '❌ ' + (result.error || 'Failed');
        msg.style.color = 'var(--red)';
      }
    } catch(e) {
      msg.textContent = '❌ ' + e.message;
      msg.style.color = 'var(--red)';
    }
  }

  function exportLogs() {
    const text = Array.from(stream.children).map(l => l.textContent).join('\\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], {type:'text/plain'}));
    a.download = 'bwhero-logs.txt';
    a.click();
  }
</script>
</body>
</html>`);
});

// ========================
// 🖼️ Image Handler
// ========================
app.get('/', async (req, res) => {
  const startTime = Date.now();
  const raw = req.query.url;

  if (!raw) return res.redirect('/dashboard');
  if (typeof raw !== 'string') return res.status(400).send('Invalid ?url= parameter');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return res.status(400).send('Invalid ?url= parameter');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).send('Only http(s) URLs are allowed');
  }
  if (CONFIG.BLOCK_PRIVATE) {
    const h = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(h) && isPrivateIp(h)) {
      addLog(`🚫 BLOCKED | ${raw}`);
      return res.status(403).send('Blocked host');
    }
  }
  parsed.hash = '';
  const fetchUrl = parsed.href;

  const quality = Math.min(100, Math.max(10, parseInt(req.query.l, 10) || 85));
  const useJpeg = req.query.jpg === '1' || req.query.jpeg === '1';
  const bw = req.query.bw === '1';
  const wRaw = parseInt(req.query.w, 10);
  const width = Number.isFinite(wRaw) ? Math.min(4096, Math.max(64, wRaw)) : 0;

  const key = `${fetchUrl}|q${quality}|j${+useJpeg}|b${+bw}|w${width}`;

  const hit = cache.get(key);
  if (hit) {
    stats.cacheHits++;
    addLog(`💜 CACHE HIT | ${kb(hit.buf.length)}KB | ${fetchUrl}`);
    return sendImage(res, hit, 'HIT', startTime);
  }

  const job = getJob(key, { fetchUrl, parsed, quality, useJpeg, bw, width });

  // Client went away → drop its ref; if nobody is left waiting, cancel fetch / queue slot
  res.on('close', () => {
    if (res.writableEnded) return;
    if (--job.refs <= 0) {
      job.ac.abort();
      if (inflight.get(key) === job) inflight.delete(key);
    }
  });

  try {
    const entry = await job.promise;
    if (res.destroyed || res.writableEnded || res.headersSent) return;
    sendImage(res, entry, 'MISS', startTime);
  } catch (err) {
    if (isAbort(err) || res.destroyed || res.writableEnded || res.headersSent) return;
    if (err instanceof HttpError) return res.status(err.status >= 400 ? err.status : 502).send(err.message);
    if (err.code === 'EQUEUE') {
      res.set('Retry-After', '2');
      return res.status(503).send('Server busy, retry shortly');
    }
    if (isBlocked(err)) return res.status(403).send('Blocked host');
    res.status(500).send(`Server error: ${err.message}`);
  }
});

// ========================
// 📡 API Endpoints
// ========================

// Backup download
app.get('/backup', (req, res) => {
  saveStats();
  const json = JSON.stringify({ stats, exportedAt: new Date().toISOString(), version: '1' }, null, 2);
  res.set({
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="bwhero-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    'Content-Length': Buffer.byteLength(json)
  }).send(json);
});

// Restore from backup (POST JSON body)
const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
app.post('/restore', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.stats || typeof data.stats !== 'object') return res.status(400).json({ error: 'Invalid backup file' });
    const s = data.stats;
    stats.requests = num(s.requests);
    stats.cacheHits = num(s.cacheHits);
    stats.totalBytesSaved = num(s.totalBytesSaved);
    stats.totalBytesReceived = num(s.totalBytesReceived);
    stats.errors = num(s.errors);
    stats.startTime = num(s.startTime) || Date.now();
    stats.periods = s.periods && typeof s.periods === 'object' && !Array.isArray(s.periods) ? s.periods : {};
    saveStats();
    addLog(`📥 RESTORED | Stats restored from backup (${new Date(stats.startTime).toISOString()})`);
    res.json({ ok: true, message: 'Stats restored' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    concurrency: { active: sem.active, max: sem.max, queued: sem.queue.length, inflight: inflight.size },
    cache: { items: cache.size, mb: +(cache.bytes / 1024 / 1024).toFixed(1), maxMb: CONFIG.CACHE_MAX_MB },
    memory: { rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576) }
  });
});

app.get('/stats-json', (req, res) => {
  res.json(buildStatsJson());
});

app.get('/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  const clientId = ++clientSeq;
  const send = message => res.write(`data: ${JSON.stringify({ message })}\n\n`);

  // pm2 log history (tail only, survives restarts)
  const pm2Lines = readPm2Logs();
  if (pm2Lines.length > 0) {
    send('── pm2 history ──');
    pm2Lines.forEach(send);
    send('── live ──');
  }

  // In-memory lines from the current session
  liveLogs.lines.forEach(send);

  liveLogs.clients.push({ id: clientId, res });
  req.on('close', () => {
    liveLogs.clients = liveLogs.clients.filter(c => c.id !== clientId);
  });
});

// ========================
// 🏁 Start / shutdown
// ========================
// >>> refcheck v2 (Referer Lab: error log, referer tester, bot-challenge detection, live referer + cookie rules)
;(function refcheck() {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dns = require('dns'), net = require('net'), http = require('http'), https = require('https');
  const express = require('express');

  const DATA_DIR = process.env.REFCHECK_DIR || path.join(os.homedir(), '.pm2');
  const ERR_FILE = path.join(DATA_DIR, 'bwhero-errors.json');
  const RULES_FILE = path.join(DATA_DIR, 'bwhero-referers.json');
  const COOKIES_FILE = path.join(DATA_DIR, 'bwhero-cookies.json');
  const TOKEN = process.env.REFCHECK_TOKEN || '';
  const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
  const MAX_URLS = 3000, MAX_HITS = 50, MAX_RECHECK = 40, MAX_REFERERS = 16;
  const FLAG_TTL = 10 * 60 * 1000;
  const COOKIE_RE = /^[\x20-\x7e]{3,4000}$/, UA_RE = /^[\x20-\x7e]{5,300}$/;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const KNOWN = ['https://mangak.io/', 'https://likemanga.ink/', 'https://mangabuddy.com/', 'https://res.mgcdn.xyz/',
    'https://mangapill.com/', 'https://hentaifox.com/', 'https://nhentai.net/', 'https://hentalk.pw/'];

  // ---------- storage ----------
  function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
  function writeJson(f, data, mode) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f + '.tmp', JSON.stringify(data), mode ? { mode } : undefined);
      fs.renameSync(f + '.tmp', f);
    } catch (e) {}
  }
  const errors = new Map(Object.entries(readJson(ERR_FILE, {})));
  let rules = readJson(RULES_FILE, []);
  if (!Array.isArray(rules)) rules = [];
  let cookies = readJson(COOKIES_FILE, []);
  if (!Array.isArray(cookies)) cookies = [];
  let dirty = false;
  const saveErrors = () => { dirty = false; writeJson(ERR_FILE, Object.fromEntries(errors)); };
  const saveCookies = () => writeJson(COOKIES_FILE, cookies, 0o600);
  setInterval(() => {
    const old = Date.now() - 7 * 86400000;
    for (const [k, v] of errors) if (v.last < old) { errors.delete(k); dirty = true; }
    if (dirty) saveErrors();
  }, 60000).unref();
  process.on('exit', () => { if (dirty) saveErrors(); });

  // ---------- error collector (listens to addLog) ----------
  const ERR_RE = /^\u274C\s+(.+?)\s+\|\s+(https?:\/\/\S+)\s*$/;
  const OK_RE = /^\S+\s+(COMPRESSED|ORIGINAL|SKIP|CACHE HIT)\b.*\|\s+(https?:\/\/\S+)\s*$/;

  function record(url, kind) {
    let e = errors.get(url);
    if (!e) {
      if (errors.size >= MAX_URLS) {
        let oldest = null, ot = Infinity;
        for (const [k, v] of errors) if (v.last < ot) { ot = v.last; oldest = k; }
        errors.delete(oldest);
      }
      let host = '';
      try { host = new URL(url).hostname; } catch (_) {}
      e = { url, host, kind, first: Date.now(), last: 0, hits: [], ok: 0 };
      errors.set(url, e);
    }
    const now = Date.now();
    e.kind = kind; e.last = now; e.hits.push(now);
    if (e.hits.length > MAX_HITS) e.hits.shift();
    dirty = true;
  }

  function onLog(msg) {
    let m = ERR_RE.exec(msg);
    if (m) return record(m[2], m[1]);
    m = OK_RE.exec(msg);
    if (m) { const e = errors.get(m[2]); if (e) { e.ok = Date.now(); dirty = true; } }
  }

  try {
    const origAddLog = addLog;
    addLog = function (msg) { try { onLog(String(msg)); } catch (_) {} return origAddLog.apply(this, arguments); };
  } catch (e) { console.error('refcheck: could not hook addLog:', e.message); }

  // ---------- live referer rules (override getRefererForHost, no restart needed) ----------
  try {
    const origRef = getRefererForHost;
    getRefererForHost = function (hostname) {
      const h = String(hostname || '').toLowerCase();
      for (const r of rules) if (h.includes(r.match)) return r.referer;
      return origRef.apply(this, arguments);
    };
  } catch (e) { console.error('refcheck: could not hook getRefererForHost:', e.message); }

  // ---------- live cookie rules (added to the proxy's upstream requests via an axios interceptor) ----------
  // strict domain match (akuma.moe and *.akuma.moe only) so a cookie can never leak to look-alike hosts
  function cookieRuleFor(host) {
    host = String(host || '').toLowerCase();
    return cookies.find(c => host === c.match || host.endsWith('.' + c.match));
  }
  function ckFor(host) { const r = cookieRuleFor(host); return r ? { cookie: r.cookie, ua: r.ua } : null; }
  function setHeader(cfg, name, val) {
    if (cfg.headers && typeof cfg.headers.set === 'function') cfg.headers.set(name, val);
    else { cfg.headers = cfg.headers || {}; cfg.headers[name] = val; }
  }
  try {
    const axiosLib = require('axios');
    if (axiosLib.interceptors && axiosLib.interceptors.request) {
      axiosLib.interceptors.request.use(cfg => {
        try {
          const r = cookieRuleFor(new URL(cfg.url, cfg.baseURL).hostname);
          if (r) { setHeader(cfg, 'Cookie', r.cookie); if (r.ua) setHeader(cfg, 'User-Agent', r.ua); }
        } catch (_) {}
        return cfg;
      });
    }
  } catch (e) { console.error('refcheck: could not add cookie interceptor:', e.message); }

  // ---------- safe probing (SSRF guarded) ----------
  function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
      const [a, b] = ip.split('.').map(Number);
      return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (net.isIPv6(ip)) {
      const l = ip.toLowerCase();
      if (l === '::1' || l === '::') return true;
      if (l.startsWith('::ffff:')) { const v4 = l.slice(7); return net.isIPv4(v4) ? isPrivateIp(v4) : true; }
      return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
    }
    return true;
  }

  function guardedLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, options || {}, (err, ...args) => {
      if (err) return cb(err);
      if (!ALLOW_PRIVATE) {
        const list = options && options.all ? args[0] : [{ address: args[0] }];
        if (list.some(a => isPrivateIp(a.address))) {
          const e = new Error('Blocked private address'); e.code = 'EBLOCKED'; return cb(e);
        }
      }
      cb(null, ...args);
    });
  }

  function assertAllowed(u) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (!ALLOW_PRIVATE && net.isIP(h) && isPrivateIp(h)) throw new Error('Blocked private address');
  }

  // which bot-protection served this non-image response?
  function classify(h, body) {
    const server = String(h.server || '').toLowerCase();
    const sc = [].concat(h['set-cookie'] || []).join(';');
    const b = String(body || '').toLowerCase();
    if (server.includes('ddos-guard') || /__ddg[a-z0-9]*_/.test(sc) || b.includes('ddos-guard')) return 'DDoS-Guard';
    if (h['cf-mitigated'] === 'challenge' || /just a moment|cf-chl|attention required|cf-browser-verification/.test(b)) return 'Cloudflare';
    if (server.includes('sucuri') || h['x-sucuri-id']) return 'Sucuri';
    if (/captcha|verify you are human|checking your browser|are you a robot/.test(b)) return 'Bot check';
    return '';
  }

  // images: headers only, body dropped at once. Anything else: first 4KB, to identify the block page
  function probeOnce(u, referer, ck) {
    return new Promise((resolve, reject) => {
      const headers = { 'User-Agent': (ck && ck.ua) || UA, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
      if (referer) headers.Referer = referer;
      if (ck && ck.cookie) headers.Cookie = ck.cookie;
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'GET', headers, lookup: guardedLookup, agent: false, timeout: 10000 }, res => {
        const chunks = []; let n = 0, done = false;
        const finish = () => {
          if (done) return; done = true; res.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        };
        if (/^image\//i.test(String(res.headers['content-type'] || ''))) return finish();
        res.on('data', c => { chunks.push(c); n += c.length; if (n >= 4096) finish(); });
        res.on('end', finish);
        res.on('error', finish);
      });
      req.on('timeout', () => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; req.destroy(e); });
      req.on('error', reject);
      req.end();
    });
  }

  async function probe(urlStr, referer, ck) {
    const t0 = Date.now();
    try {
      let u = new URL(urlStr);
      const origin = u.hostname;
      for (let i = 0; i <= 5; i++) {
        assertAllowed(u);
        const r = await probeOnce(u, referer, u.hostname === origin ? ck : null);
        if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) { u = new URL(r.headers.location, u); continue; }
        const type = String(r.headers['content-type'] || '');
        const ok = r.status === 200 && /^image\//i.test(type);
        return {
          status: r.status, type: type.split(';')[0], ms: Date.now() - t0, ok,
          len: r.headers['content-length'] ? Number(r.headers['content-length']) : null,
          provider: ok ? '' : classify(r.headers, r.body)
        };
      }
      return { status: 0, error: 'too many redirects', ok: false, ms: Date.now() - t0, provider: '' };
    } catch (e) {
      return { status: 0, error: e.code || e.message, ok: false, ms: Date.now() - t0, provider: '' };
    }
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  function candidates(urlStr, extra) {
    const u = new URL(urlStr), host = u.hostname.toLowerCase(), list = [];
    const add = (label, ref) => { if (!list.some(x => x.referer === ref)) list.push({ label, referer: ref }); };
    add('current rule', getRefererForHost(u.hostname, urlStr));
    (extra || []).forEach(r => add('custom', r));
    add('no referer', '');
    add('same host', 'https://' + host + '/');
    const parts = host.split('.');
    if (parts.length > 2) add('parent domain', 'https://' + parts.slice(-2).join('.') + '/');
    rules.forEach(r => add('live rule', r.referer));
    KNOWN.forEach(r => add('known site', r));
    return list.slice(0, MAX_REFERERS);
  }

  // qvzra + qvzrb + qvzrc -> "qvzr"
  function suggest(host, hosts) {
    if (net.isIP(host)) return host;
    const sld = h => { const p = h.split('.'); return p.length >= 2 ? p[p.length - 2] : h; };
    const tld = h => h.split('.').pop();
    let p = sld(host);
    hosts.filter(h => tld(h) === tld(host) && sld(h) !== sld(host)).forEach(h => {
      const s = sld(h); let i = 0;
      while (i < p.length && i < s.length && p[i] === s[i]) i++;
      if (i >= 4) p = p.slice(0, i);
    });
    return p;
  }

  const baseDomain = host => (net.isIP(host) ? host : host.split('.').slice(-2).join('.'));

  function dominant(list) {
    const c = {};
    list.filter(Boolean).forEach(x => { c[x] = (c[x] || 0) + 1; });
    const top = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
    return top && c[top] * 2 >= list.length ? top : '';
  }

  // ---------- per-host diagnosis: fixable by referer / bot challenge / unknown ----------
  const hostFlags = new Map();
  const classifying = new Set();

  async function classifyHost(host, sampleUrl) {
    if (classifying.has(host)) return;
    classifying.add(host);
    try {
      const ck = ckFor(host);
      const res = await pool(candidates(sampleUrl, []), 4, async c => Object.assign({ referer: c.referer }, await probe(sampleUrl, c.referer, ck)));
      const good = res.find(r => r.ok);
      if (good) hostFlags.set(host, { state: 'fixable', referer: good.referer, at: Date.now() });
      else {
        const provider = dominant(res.map(r => r.provider));
        hostFlags.set(host, { state: provider ? 'challenge' : 'unknown', provider, status: res[0] ? res[0].status : 0, at: Date.now() });
      }
    } catch (e) {} finally { classifying.delete(host); }
  }

  function cutoffFor(s) {
    s = String(s || '1h');
    if (s === 'all') return 0;
    const m = /^(\d+)([mhd])$/.exec(s);
    if (!m) return Date.now() - 3600000;
    return Date.now() - Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
  }

  // ---------- routes ----------
  let busy = 0;
  const json = () => express.json({ limit: '50kb' });
  function auth(req, res, next) {
    if (!TOKEN) return next();
    const g = String(req.query.token || (req.get && req.get('x-token')) || '');
    if (g === TOKEN) return next();
    res.status(401).json({ error: 'token required: open /refcheck?token=YOUR_TOKEN' });
  }
  const maskCookies = () => cookies.map(c => ({
    id: c.id, match: c.match, added: c.added, ua: !!c.ua,
    names: c.cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean)
  }));

  app.get('/refcheck', auth, (req, res) => res.type('html').send(PAGE));

  app.get('/refcheck/api/errors', auth, (req, res) => {
    const cutoff = cutoffFor(req.query.since);
    const items = [], hostMap = new Map();
    let recovered = 0;
    for (const e of errors.values()) {
      if (e.last < cutoff) continue;
      const fixed = e.ok > e.last;
      const hits = e.hits.filter(t => t >= cutoff).length;
      items.push({ url: e.url, host: e.host, kind: e.kind, last: e.last, hits, fixed });
      if (fixed) { recovered++; continue; }
      const h = hostMap.get(e.host) || { host: e.host, urls: 0, hits: 0, kinds: {}, sample: e.url, sampleAt: 0 };
      h.urls++; h.hits += hits; h.kinds[e.kind] = (h.kinds[e.kind] || 0) + 1;
      if (e.last > h.sampleAt) { h.sample = e.url; h.sampleAt = e.last; }
      hostMap.set(e.host, h);
    }
    const failHosts = [...hostMap.values()].sort((a, b) => b.hits - a.hits).slice(0, 30);
    const names = failHosts.map(h => h.host);
    let started = 0, pending = 0, blocked = 0, fixable = 0;
    failHosts.forEach(h => {
      const f = hostFlags.get(h.host);
      if (!f || Date.now() - f.at > FLAG_TTL) {
        pending++;
        if (started < 4 && classifying.size < 5 && !classifying.has(h.host)) { started++; classifyHost(h.host, h.sample); }
      }
      h.flag = f ? { state: f.state, provider: f.provider || '', referer: f.referer || '', status: f.status || 0 } : null;
      h.suggest = suggest(h.host, names);
      if (f && f.state === 'challenge') blocked += h.urls;
      if (f && f.state === 'fixable') fixable += h.urls;
      delete h.sample; delete h.sampleAt;
    });
    items.sort((a, b) => (a.fixed - b.fixed) || (b.last - a.last));
    res.json({
      since: String(req.query.since || '1h'), now: Date.now(),
      failing: items.length - recovered, recovered, blocked, fixable, pending,
      hosts: failHosts, items: items.slice(0, 200)
    });
  });

  app.post('/refcheck/api/errors/clear', auth, (req, res) => { errors.clear(); hostFlags.clear(); saveErrors(); res.json({ ok: true }); });

  app.post('/refcheck/api/test', auth, json(), async (req, res) => {
    if (busy >= 3) return res.status(429).json({ error: 'Busy, try again in a few seconds' });
    const b = req.body || {};
    const urlStr = String(b.url || '').trim();
    let u;
    try { u = new URL(urlStr); assertAllowed(u); } catch (e) { return res.status(400).json({ error: e.message }); }
    const extra = String(b.extra || '').split(/[\s,]+/).filter(s => /^https?:\/\//i.test(s)).slice(0, 4);
    const cookieStr = String(b.cookie || '').trim().replace(/^cookie:\s*/i, '');
    const uaStr = String(b.ua || '').trim();
    if (cookieStr && !COOKIE_RE.test(cookieStr)) return res.status(400).json({ error: 'Cookie has invalid characters - paste it as name=value; name2=value2' });
    if (uaStr && !UA_RE.test(uaStr)) return res.status(400).json({ error: 'User-Agent has invalid characters' });
    const rule = cookieRuleFor(u.hostname);
    const ck = cookieStr ? { cookie: cookieStr, ua: uaStr } : (rule ? { cookie: rule.cookie, ua: rule.ua } : null);
    busy++;
    try {
      const results = await pool(candidates(urlStr, extra), 5, async c => Object.assign({ label: c.label, referer: c.referer }, await probe(urlStr, c.referer, ck)));
      results.sort((a, b2) => (b2.ok - a.ok) || (a.ms - b2.ms));
      const anyOk = results.some(r => r.ok);
      const hosts = [...new Set([...errors.values()].filter(e => !(e.ok > e.last)).map(e => e.host))];
      res.json({
        url: urlStr, host: u.hostname, suggest: suggest(u.hostname, hosts),
        cookie: cookieStr ? 'explicit' : (rule ? 'rule' : ''), cookieDomain: baseDomain(u.hostname),
        provider: anyOk ? '' : dominant(results.map(r => r.provider)), results
      });
    } finally { busy--; }
  });

  app.post('/refcheck/api/recheck', auth, json(), async (req, res) => {
    if (busy >= 3) return res.status(429).json({ error: 'Busy, try again in a few seconds' });
    const b = req.body || {};
    const ref = String(b.referer || '').trim();
    if (ref && !/^https?:\/\//i.test(ref)) return res.status(400).json({ error: 'Referer must start with http(s)://' });
    const cutoff = cutoffFor(b.since);
    const all = [...errors.values()].filter(e => e.last >= cutoff && !(e.ok > e.last)).sort((a, b2) => b2.last - a.last);
    busy++;
    try {
      const out = await pool(all.slice(0, MAX_RECHECK), 6, async e => {
        const r = ref || getRefererForHost(e.host, e.url);
        const p = await probe(e.url, r, ckFor(e.host));
        if (p.ok && !ref) { e.ok = Date.now(); dirty = true; }
        return { url: e.url, host: e.host, referer: r, status: p.status, type: p.type, error: p.error, ok: p.ok, ms: p.ms, provider: p.provider };
      });
      res.json({ checked: out.length, truncated: all.length > MAX_RECHECK, referer: ref || 'current rules', good: out.filter(o => o.ok), bad: out.filter(o => !o.ok) });
    } finally { busy--; }
  });

  app.get('/refcheck/api/rules', auth, (req, res) => res.json({ rules, cookies: maskCookies() }));

  app.post('/refcheck/api/rules', auth, json(), (req, res) => {
    const b = req.body || {};
    const match = String(b.match || '').trim().toLowerCase();
    const referer = String(b.referer || '').trim();
    if (!/^[a-z0-9.-]{2,60}$/.test(match)) return res.status(400).json({ error: 'Rule key: 2-60 chars, a-z 0-9 . -' });
    if (!/^https?:\/\/\S{3,200}$/i.test(referer)) return res.status(400).json({ error: 'Referer must be a full http(s) URL' });
    rules = rules.filter(r => r.match !== match);
    rules.unshift({ id: Date.now().toString(36), match, referer, added: Date.now() });
    if (rules.length > 100) rules.length = 100;
    writeJson(RULES_FILE, rules);
    hostFlags.clear();
    addLog('\uD83E\uDDEA RULE | ' + match + ' -> ' + referer);
    res.json({ ok: true, rules });
  });

  app.delete('/refcheck/api/rules/:id', auth, (req, res) => {
    rules = rules.filter(r => r.id !== req.params.id);
    writeJson(RULES_FILE, rules);
    hostFlags.clear();
    res.json({ ok: true, rules });
  });

  app.post('/refcheck/api/cookies', auth, json(), (req, res) => {
    const b = req.body || {};
    const match = String(b.match || '').trim().toLowerCase().replace(/^\./, '');
    const cookie = String(b.cookie || '').trim().replace(/^cookie:\s*/i, '');
    const ua = String(b.ua || '').trim();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(match)) return res.status(400).json({ error: 'Domain must be a full domain like akuma.moe' });
    if (!COOKIE_RE.test(cookie)) return res.status(400).json({ error: 'Cookie missing or has invalid characters' });
    if (ua && !UA_RE.test(ua)) return res.status(400).json({ error: 'User-Agent has invalid characters' });
    cookies = cookies.filter(c => c.match !== match);
    cookies.unshift({ id: Date.now().toString(36), match, cookie, ua, added: Date.now() });
    if (cookies.length > 20) cookies.length = 20;
    saveCookies();
    hostFlags.clear();
    addLog('\uD83E\uDDEA COOKIE RULE | ' + match + ' (' + maskCookies()[0].names.length + ' cookies)');
    res.json({ ok: true, cookies: maskCookies() });
  });

  app.delete('/refcheck/api/cookies/:id', auth, (req, res) => {
    cookies = cookies.filter(c => c.id !== req.params.id);
    saveCookies();
    hostFlags.clear();
    res.json({ ok: true, cookies: maskCookies() });
  });

  // ---------- page ----------
  const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Referer Lab</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--accent:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--text:#e2e8f0;--muted:#64748b;--mono:ui-monospace,Menlo,Consolas,monospace}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
.top{background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
.top a{color:var(--muted);text-decoration:none;font-size:13px}
.wrap{max-width:760px;margin:0 auto;padding:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px}
h3{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.chip,.btn{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:20px;font-size:12px;cursor:pointer;font-family:inherit}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.btn{border-radius:8px}.btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}.btn.ok{background:#14532d;border-color:#166534;color:#4ade80}
.btn:disabled{opacity:.5}
input,textarea{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:9px 10px;border-radius:8px;font-size:13px;font-family:var(--mono);margin:6px 0}
textarea{height:110px;resize:vertical;font-size:11px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px}
.row>div{min-width:0}.row:last-child{border-bottom:none}
.mono{font-family:var(--mono);word-break:break-all}
.muted{color:var(--muted)}.good{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--yellow)}
.badge{font-family:var(--mono);font-size:11px;padding:2px 7px;border-radius:10px;background:var(--bg)}
.acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.note{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0;font-size:12px;line-height:1.5}
</style></head><body>
<div class="top"><a href="/dashboard">&larr; Dashboard</a><b>Referer Lab</b><span></span></div>
<div class="wrap">

<div class="card"><h3>Failing URLs</h3>
 <div class="chips" id="chips">
  <button class="chip" data-act="since" data-s="15m">15m</button><button class="chip" data-act="since" data-s="30m">30m</button>
  <button class="chip" data-act="since" data-s="1h">1h</button><button class="chip" data-act="since" data-s="6h">6h</button>
  <button class="chip" data-act="since" data-s="24h">24h</button><button class="chip" data-act="since" data-s="7d">7d</button>
  <button class="chip" data-act="since" data-s="all">all</button>
 </div>
 <div id="err-box" class="muted">Loading...</div>
 <input id="re-ref" placeholder="Referer for re-check (blank = current rules)">
 <div class="acts">
  <button class="btn pri" id="btn-recheck" data-act="recheck">Re-check all</button>
  <button class="btn" data-act="copyfailing">Copy failing URLs</button>
  <button class="btn" data-act="clear">Clear list</button>
 </div>
 <div id="re-out"></div>
</div>

<div class="card"><h3>Test one URL against many referers</h3>
 <input id="t-url" placeholder="https://rx.qvzra.org/r/p/xxx/yyy.webp">
 <input id="t-extra" placeholder="Extra referer(s) to try (optional)">
 <input id="t-cookie" placeholder="Cookie header from a browser that passed the check (optional)">
 <input id="t-ua" placeholder="User-Agent of that same browser (optional)">
 <div class="acts"><button class="btn pri" id="btn-test" data-act="runtest">Test</button></div>
 <div id="t-out"></div>
</div>

<div class="card"><h3>Live rules (active instantly, no restart)</h3>
 <div id="rules"></div><div id="ckrules"></div><div id="rule-msg" class="muted" style="margin-top:8px"></div>
</div>
</div>
<script>
var $=function(i){return document.getElementById(i)};
var NL=String.fromCharCode(10);
var TOKEN=new URLSearchParams(location.search).get('token')||'';
var since='1h',lastErrors=null,polls=0;
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function api(path,body,method){
  var u='/refcheck/api/'+path;if(TOKEN)u+=(u.indexOf('?')<0?'?':'&')+'token='+encodeURIComponent(TOKEN);
  var o={method:method||(body?'POST':'GET'),headers:{}};
  if(body){o.headers['Content-Type']='application/json';o.body=JSON.stringify(body)}
  return fetch(u,o).then(function(r){return r.json()});
}
function ago(ts){var s=Math.round((Date.now()-ts)/1000);if(s<60)return s+'s';if(s<3600)return Math.round(s/60)+'m';if(s<86400)return Math.round(s/3600)+'h';return Math.round(s/86400)+'d'}
function kb(n){return n>=1048576?(n/1048576).toFixed(1)+'MB':Math.round(n/1024)+'KB'}
function copyText(t,btn){
  function done(){if(btn){var o=btn.textContent;btn.textContent='Copied';setTimeout(function(){btn.textContent=o},1200)}}
  function fb(){var a=document.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();try{document.execCommand('copy');done()}catch(e){prompt('Copy:',t)}document.body.removeChild(a)}
  if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(t).then(done,fb);else fb();
}
function setSince(s){since=s;polls=0;[].forEach.call(document.querySelectorAll('.chip'),function(c){c.classList.toggle('on',c.dataset.s===s)});loadErrors()}
function flagHtml(f){
  if(!f)return '<span class="badge muted">checking...</span> ';
  if(f.state==='challenge')return '<span class="badge bad">&#128737; '+esc(f.provider)+' bot challenge</span> ';
  if(f.state==='fixable')return '<span class="badge good">&#128161; fixable with a referer</span> ';
  return '<span class="badge warn">blocked ('+(f.status||'?')+')</span> ';
}
function loadErrors(){
  api('errors?since='+since).then(function(d){
    lastErrors=d;
    var h='<div class="muted" style="margin-bottom:8px">'+d.failing+' failing &middot; '+d.recovered+' recovered (last '+esc(since)+')';
    if(d.blocked)h+=' &middot; <span class="bad">'+d.blocked+' behind a bot challenge</span>';
    if(d.fixable)h+=' &middot; <span class="good">'+d.fixable+' fixable by referer</span>';
    h+='</div>';
    d.hosts.forEach(function(x){
      var k=Object.keys(x.kinds).map(function(n){return n+' x'+x.kinds[n]}).join(', ');
      h+='<div class="row"><div><span class="mono">'+esc(x.host)+'</span> '+flagHtml(x.flag)+'<div class="muted">'+x.urls+' url &middot; '+x.hits+' hits &middot; '+esc(k)+'</div>';
      if(x.flag&&x.flag.state==='fixable')h+='<div class="mono good">'+esc(x.flag.referer||'(no referer needed)')+'</div>';
      if(x.flag&&x.flag.state==='challenge')h+='<div class="muted">No referer can pass this. Use a cookie rule (Test card) or load this source directly.</div>';
      h+='</div>';
      if(x.flag&&x.flag.state==='fixable'&&x.flag.referer)h+='<button class="btn pri" data-act="applyhost" data-key="'+esc(x.suggest)+'" data-ref="'+esc(x.flag.referer)+'">Apply</button>';
      h+='</div>';
    });
    h+='<div style="margin-top:10px">';
    d.items.slice(0,60).forEach(function(it){
      h+='<div class="row"><div><span class="badge '+(it.fixed?'good':'bad')+'">'+(it.fixed?'ok now':esc(it.kind))+'</span> <span class="muted">'+ago(it.last)+' ago &middot; x'+it.hits+'</span><div class="mono">'+esc(it.url)+'</div></div><button class="btn" data-act="test" data-url="'+esc(it.url)+'">Test</button></div>';
    });
    if(!d.items.length)h+='<div class="muted">No errors in this window.</div>';
    $('err-box').innerHTML=h+'</div>';
    if(d.pending>0&&polls<3){polls++;setTimeout(loadErrors,3000)}
  });
}
function recheck(){
  var b=$('btn-recheck');b.disabled=true;b.textContent='Checking...';polls=0;
  api('recheck',{since:since,referer:$('re-ref').value.trim()}).then(function(d){
    b.disabled=false;b.textContent='Re-check all';
    if(d.error){$('re-out').innerHTML='<div class="bad" style="margin-top:8px">'+esc(d.error)+'</div>';return}
    var h='<div class="muted" style="margin:10px 0 6px">Checked '+d.checked+(d.truncated?' (newest only)':'')+' with '+esc(d.referer)+'</div>';
    if(d.good.length){
      var urls=d.good.map(function(x){return x.url}).join(NL);
      h+='<div class="good">'+d.good.length+' good - copy these</div><textarea readonly id="good-list">'+esc(urls)+'</textarea><div class="acts"><button class="btn ok" data-act="copyid" data-id="good-list">Copy '+d.good.length+' links</button></div>';
    }
    if(d.bad.length){
      var ch=d.bad.filter(function(x){return x.provider}).length;
      h+='<div class="bad" style="margin-top:10px">'+d.bad.length+' still failing'+(ch?' ('+ch+' behind a bot challenge)':'')+'</div>';
      d.bad.forEach(function(x){h+='<div class="row"><div class="mono">'+esc(x.url)+'<div class="muted">'+(x.status||esc(x.error||'err'))+' '+esc(x.type||'')+(x.provider?' &middot; &#128737; '+esc(x.provider):'')+'</div></div><button class="btn" data-act="test" data-url="'+esc(x.url)+'">Test</button></div>'});
    }
    if(!d.good.length&&!d.bad.length)h+='<div class="muted">Nothing to check in this window.</div>';
    $('re-out').innerHTML=h;loadErrors();
  });
}
function runTest(){
  var b=$('btn-test');b.disabled=true;b.textContent='Testing...';
  api('test',{url:$('t-url').value.trim(),extra:$('t-extra').value.trim(),cookie:$('t-cookie').value.trim(),ua:$('t-ua').value.trim()}).then(function(d){b.disabled=false;b.textContent='Test';renderTest(d)});
}
function renderTest(d){
  if(d.error){$('t-out').innerHTML='<div class="bad" style="margin-top:8px">'+esc(d.error)+'</div>';return}
  var best=d.results.filter(function(r){return r.ok})[0];
  var h='<div class="muted" style="margin:6px 0">'+esc(d.host)+(d.cookie==='rule'?' &middot; using the saved cookie rule':'')+(d.cookie==='explicit'?' &middot; using the cookie you pasted':'')+'</div>';
  if(best){
    var curl='curl -L'+(best.referer?' -e "'+best.referer+'"':'')+' "'+d.url+'" -o /dev/null -w "%{http_code} %{content_type}"';
    h+='<div class="good" style="margin:6px 0">Working link + referer</div><textarea readonly>'+esc(d.url+NL+'referer: '+(best.referer||'(none)')+NL+curl)+'</textarea>';
    h+='<div class="acts"><button class="btn ok" data-act="copy" data-text="'+esc(d.url)+'">Copy link</button><button class="btn" data-act="copy" data-text="'+esc(curl)+'">Copy curl</button></div>';
    if(d.cookie==='explicit'){
      h+='<div class="note good">This works with the cookie you pasted. Save it so the proxy sends it for this domain (and its subdomains) automatically:<input id="ck-key" value="'+esc(d.cookieDomain)+'"><button class="btn pri" data-act="applycookie">Save cookie rule</button></div>';
    }
    h+='<div class="muted" style="margin-top:10px">Rule key (host contains):</div><input id="rule-key" value="'+esc(d.suggest)+'">';
  }else if(d.provider){
    h+='<div class="note bad">&#128737; Every referer is blocked by <b>'+esc(d.provider)+'</b>. This is a bot challenge, not a referer problem, so no referer rule can fix it. Paste a cookie (and the User-Agent) from a browser that passed the check into the boxes above and test again, or load this source directly instead of through the proxy.</div>';
  }else h+='<div class="bad" style="margin:6px 0">No referer worked - link may be expired or needs other headers</div>';
  d.results.forEach(function(r){
    h+='<div class="row"><div><span class="badge '+(r.ok?'good':'bad')+'">'+(r.ok?'OK ':'X ')+(r.status||esc(r.error||'err'))+'</span> <span class="muted">'+esc(r.type||'')+' '+(r.len!=null?kb(r.len)+' ':'')+r.ms+'ms'+(r.provider?' &middot; &#128737; '+esc(r.provider):'')+'</span><div class="mono">'+esc(r.label)+': '+esc(r.referer||'(none)')+'</div></div>';
    if(r.ok&&r.referer)h+='<div class="acts"><button class="btn" data-act="copy" data-text="'+esc(r.referer)+'">Copy</button><button class="btn pri" data-act="apply" data-ref="'+esc(r.referer)+'">Apply</button></div>';
    h+='</div>';
  });
  $('t-out').innerHTML=h;
}
function saveRule(key,ref){
  api('rules',{match:key,referer:ref}).then(function(d){
    $('rule-msg').textContent=d.error?('Error: '+d.error):('Live now: host contains "'+key+'" -> '+ref+' (re-check to confirm)');
    loadRules();polls=0;loadErrors();
  });
}
function applyCookie(){
  api('cookies',{match:$('ck-key').value,cookie:$('t-cookie').value.trim(),ua:$('t-ua').value.trim()}).then(function(d){
    $('rule-msg').textContent=d.error?('Error: '+d.error):('Cookie rule live for '+$('ck-key').value+' (values are never shown again)');
    loadRules();
  });
}
function loadRules(){
  api('rules').then(function(d){
    var h='<div class="muted" style="margin-bottom:6px">Referer rules</div>';
    d.rules.forEach(function(r){h+='<div class="row"><div class="mono">host has <b>'+esc(r.match)+'</b> -> '+esc(r.referer)+'</div><button class="btn" data-act="del" data-id="'+esc(r.id)+'">Delete</button></div>'});
    if(!d.rules.length)h+='<div class="muted">None yet. Test a failing URL and press Apply on a working referer.</div>';
    else{
      var code=d.rules.map(function(r){return 'if (host.includes("'+r.match+'")) return "'+r.referer+'";'}).join(NL);
      h+='<div class="muted" style="margin-top:10px">Make permanent - paste into getRefererForHost():</div><textarea readonly>'+esc(code)+'</textarea><div class="acts"><button class="btn" data-act="copy" data-text="'+esc(code)+'">Copy as code</button></div>';
    }
    $('rules').innerHTML=h;
    var c='<div class="muted" style="margin:14px 0 6px">Cookie rules (sent only to that domain and its subdomains)</div>';
    d.cookies.forEach(function(x){c+='<div class="row"><div class="mono"><b>'+esc(x.match)+'</b> &middot; '+x.names.length+' cookies<div class="muted">'+esc(x.names.join(', '))+(x.ua?' &middot; custom User-Agent':'')+'</div></div><button class="btn" data-act="delck" data-id="'+esc(x.id)+'">Delete</button></div>'});
    if(!d.cookies.length)c+='<div class="muted">None. Cookie values are stored on the server and never shown here.</div>';
    $('ckrules').innerHTML=c;
  });
}
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-act]');if(!t)return;
  var a=t.dataset.act;
  if(a==='copy')copyText(t.dataset.text,t);
  else if(a==='copyid')copyText($(t.dataset.id).value,t);
  else if(a==='copyfailing'){if(lastErrors)copyText(lastErrors.items.filter(function(i){return !i.fixed}).map(function(i){return i.url}).join(NL),t)}
  else if(a==='since')setSince(t.dataset.s);
  else if(a==='recheck')recheck();
  else if(a==='runtest')runTest();
  else if(a==='test'){$('t-url').value=t.dataset.url;runTest();$('t-url').scrollIntoView({behavior:'smooth',block:'center'})}
  else if(a==='apply')saveRule(($('rule-key')||{}).value||'',t.dataset.ref);
  else if(a==='applyhost')saveRule(t.dataset.key,t.dataset.ref);
  else if(a==='applycookie')applyCookie();
  else if(a==='del')api('rules/'+t.dataset.id,null,'DELETE').then(loadRules);
  else if(a==='delck')api('cookies/'+t.dataset.id,null,'DELETE').then(loadRules);
  else if(a==='clear'){if(confirm('Clear the error list?'))api('errors/clear',{}).then(loadErrors)}
});
$('t-url').addEventListener('keydown',function(e){if(e.key==='Enter')runTest()});
setSince('1h');loadRules();
</script></body></html>`;

  addLog('\uD83E\uDDEA Referer Lab ready: /refcheck (' + rules.length + ' referer rules, ' + cookies.length + ' cookie rules)');
})();
// <<< refcheck

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Bandwidth Hero`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📡 Port:       ${PORT}`);
  console.log(`🖥️  Dashboard: http://localhost:${PORT}/`);
  console.log(`❤️  Health:    http://localhost:${PORT}/health`);
  console.log(`⚡ Parallel:   ${sem.max} jobs | threadpool ${process.env.UV_THREADPOOL_SIZE} | ${CONFIG.SHARP_THREADS} thread(s)/image`);
  console.log(`${'='.repeat(50)}\n`);

  addLog(`🚀 Bandwidth Hero started on port ${PORT}`);
  addLog(`⚡ Parallel: ${sem.max} | Threadpool: ${process.env.UV_THREADPOOL_SIZE} | WebP effort: ${CONFIG.WEBP_EFFORT} (adaptive) | Cache: ${CONFIG.CACHE_MAX_MB}MB / ${CONFIG.CACHE_TTL_MIN}m`);
});

// Behind nginx / Cloudflare: keep-alive must outlive the proxy's idle timeout
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveStatsSync();
  server.close(() => process.exit(0));
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  setTimeout(() => process.exit(0), 3000).unref(); // SSE streams would otherwise hold it open
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', e => {
  const msg = `❌ UNHANDLED | ${e && e.message ? e.message : e}`;
  console.error(msg);
  addLog(msg);
});
