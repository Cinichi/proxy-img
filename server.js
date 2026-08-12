#!/usr/bin/env node
'use strict';

const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');
const NodeCache = require('node-cache');
const fs = require('fs');
const os = require('os');

const PM2_LOG_PATH = `${os.homedir()}/.pm2/logs/hero-out.log`;
const PM2_LOG_LINES = 200;

function readPm2Logs() {
  try {
    if (!fs.existsSync(PM2_LOG_PATH)) return [];
    const content = fs.readFileSync(PM2_LOG_PATH, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    return lines.slice(-PM2_LOG_LINES);
  } catch (e) {
    return [];
  }
}

sharp.concurrency(0);
const app = express();

const MAX_CONCURRENT_PROCESSING = 20;
let activeProcesses = 0;
const processingQueue = [];

const keepAliveAgent = {
  http: new http.Agent({ keepAlive: true }),
  https: new https.Agent({ keepAlive: true })
};

const imageCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 300,
  useClones: false,
  maxKeys: 2000
});

const PORT = process.env.PORT || 4000;

const STATS_FILE = `${os.homedir()}/.pm2/bwhero-stats.json`;

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

function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8');
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
  // Prune old periods (keep last 24 keys max)
  const allKeys = Object.keys(stats.periods);
  if (allKeys.length > 60) {
    allKeys.slice(0, allKeys.length - 60).forEach(k => delete stats.periods[k]);
  }
}

let stats = loadStats();

// Save stats every 60 seconds
setInterval(saveStats, 60000);

// Save on exit
process.on('SIGINT', () => { saveStats(); process.exit(); });
process.on('SIGTERM', () => { saveStats(); process.exit(); });

// 📝 Live logs
const liveLogs = {
  lines: [],
  maxLines: 300,
  clients: []
};

function addLog(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  liveLogs.lines.push(line);
  if (liveLogs.lines.length > liveLogs.maxLines) {
    liveLogs.lines = liveLogs.lines.slice(-liveLogs.maxLines);
  }
  liveLogs.clients.forEach(client => {
    client.res.write(`data: ${JSON.stringify({ message: line })}\n\n`);
  });
}

// ========================
// 🔧 Helpers
// ========================

function getOriginalFormat(contentType) {
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpeg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpeg';
}

async function processWithLimit(fn) {
  if (activeProcesses >= MAX_CONCURRENT_PROCESSING) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Queue timeout')), 30000);
      processingQueue.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  activeProcesses++;
  try {
    return await fn();
  } finally {
    activeProcesses--;
    if (processingQueue.length > 0) processingQueue.shift()();
  }
}

function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  if (/^s\d+\.mbcdns[a-z]{1,3}\.org$/.test(host)) {
    const match = targetUrl.match(/\/manga\/([^/]+)\/chapter-(\d+)/i);
    return match
      ? `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`
      : "https://mangabuddy.com/";
  }

  if (host.includes("qvzrh")) {
  return "https://mangak.io/";
}

if (host.includes("likemanga") || host.includes("1kmgv") || host.includes("like1.") || host.includes("mangayy") || host.includes("mgread")) {
  return "https://likemanga.ink/";
}

  const map = {
    mgcdn: "https://res.mgcdn.xyz/",
    mbbcdn: "https://res.mgcdn.xyz/",
    mangapill: "https://mangapill.com/",
    readdetectiveconan: "https://mangapill.com/",
    hentaifox: "https://hentaifox.com/",
    nhentai: "https://nhentai.net/",
    hentaicdn: "https://hentalk.pw/",
  };

  for (const [k, v] of Object.entries(map)) {
    if (host.includes(k)) return v;
  }

  return `https://${hostname}/`;
}

// ========================
// 📊 Dashboard
// ========================
app.get('/dashboard', (req, res) => {
  const uptimeSec = Math.floor((Date.now() - stats.startTime) / 1000);
  const uptimeHr = (uptimeSec / 3600).toFixed(2);
  const savedMB = (stats.totalBytesSaved / 1024 / 1024).toFixed(2);
  const receivedMB = (stats.totalBytesReceived / 1024 / 1024).toFixed(2);
  const savePercent = stats.totalBytesReceived > 0
    ? ((stats.totalBytesSaved / stats.totalBytesReceived) * 100).toFixed(1) : '0.0';
  const hitRate = (stats.requests + stats.cacheHits) > 0
    ? ((stats.cacheHits / (stats.requests + stats.cacheHits)) * 100).toFixed(1) : '0.0';

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
  </nav>
</div>

<!-- STATS -->
<div id="page-stats" class="page active">
  <div class="grid">
    <div class="stat-card green">
      <div class="label">Saved</div>
      <div class="value" id="s-saved">${savedMB} MB</div>
      <div class="sub" id="s-pct">${savePercent}% reduction</div>
    </div>
    <div class="stat-card accent">
      <div class="label">Requests</div>
      <div class="value" id="s-req">${stats.requests.toLocaleString()}</div>
      <div class="sub">processed</div>
    </div>
    <div class="stat-card yellow">
      <div class="label">Cache Hits</div>
      <div class="value" id="s-hits">${stats.cacheHits.toLocaleString()}</div>
      <div class="sub" id="s-hitrate">${hitRate}% hit rate</div>
    </div>
    <div class="stat-card red">
      <div class="label">Errors</div>
      <div class="value" id="s-err">${stats.errors}</div>
      <div class="sub">&nbsp;</div>
    </div>
    <div class="stat-card">
      <div class="label">Received</div>
      <div class="value" id="s-recv">${receivedMB} MB</div>
      <div class="sub">from origin</div>
    </div>
    <div class="stat-card">
      <div class="label">Uptime</div>
      <div class="value" id="s-up">${uptimeHr}h</div>
      <div class="sub">&nbsp;</div>
    </div>
  </div>

  <div class="section">
    <h3>Concurrency</h3>
    <div class="row"><span class="k">Active / Max</span><span class="v" id="s-conc">${activeProcesses} / ${MAX_CONCURRENT_PROCESSING}</span></div>
    <div class="bar-wrap"><div class="bar" id="s-bar" style="width:${(activeProcesses/MAX_CONCURRENT_PROCESSING*100).toFixed(0)}%"></div></div>
    <div class="row" style="margin-top:10px"><span class="k">Queued</span><span class="v" id="s-queue">${processingQueue.length}</span></div>
    <div class="row"><span class="k">Cached images</span><span class="v" id="s-ckeys">${imageCache.keys().length} / 500</span></div>
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
      <div class="hval" id="h-up">${uptimeHr}h</div>
      <div class="hlabel">Uptime</div>
    </div>
    <div class="health-card">
      <div class="icon">⚡</div>
      <div class="hval">${MAX_CONCURRENT_PROCESSING}</div>
      <div class="hlabel">Max concurrency</div>
    </div>
    <div class="health-card">
      <div class="icon">🧠</div>
      <div class="hval" id="h-cache">${imageCache.keys().length}</div>
      <div class="hlabel">Cached (max 500)</div>
    </div>
    <div class="health-card">
      <div class="icon">🎯</div>
      <div class="hval">6</div>
      <div class="hlabel">WebP effort</div>
    </div>
    <div class="health-card">
      <div class="icon">💾</div>
      <div class="hval">6h</div>
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
      document.getElementById('s-conc').textContent = d.active + ' / ${MAX_CONCURRENT_PROCESSING}';
      document.getElementById('s-bar').style.width = (d.active / ${MAX_CONCURRENT_PROCESSING} * 100) + '%';
      document.getElementById('s-queue').textContent = d.queued;
      document.getElementById('s-ckeys').textContent = d.cacheKeys + ' / 500';
      document.getElementById('h-up').textContent = d.uptimeHr + 'h';
      document.getElementById('h-cache').textContent = d.cacheKeys;
      if (d.periods) { lastPeriodData = d; updatePeriodUI(d); }
    } catch(e) {}
  }
  setInterval(refreshStats, 5000);

  let autoScroll = true;
  const stream = document.getElementById('log-stream');

  function classify(m) {
    if (m.includes('✅') || m.includes('COMPRESSED')) return 'ok';
    if (m.includes('❌') || m.includes('ERROR')) return 'err';
    if (m.includes('⚠️') || m.includes('ORIGINAL') || m.includes('QUEUED') || m.includes('RETRY')) return 'warn';
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

// Redirect root → dashboard if no ?url=
app.get('/', async (req, res, next) => {
  if (!req.query.url) return res.redirect('/dashboard');
  next();
});

// ========================
// 🖼️ Image Handler
// ========================
app.get('/', async (req, res) => {
  const startTime = Date.now();

  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing ?url= parameter');

    const quality = Math.min(100, Math.max(10, parseInt(req.query.l) || 85));
    let useJpeg = req.query.jpg === '1' || req.query.jpeg === '1';
    const bw = req.query.bw === '1';

    const cacheKey = `${targetUrl}-q${quality}-jpg${useJpeg}-bw${bw}`;
    const cached = imageCache.get(cacheKey);
    if (cached) {
      stats.cacheHits++;
      const cachedFormat = cached._fmt || (useJpeg ? 'jpeg' : 'webp');
      addLog(`💜 CACHE HIT | ${(cached.length/1024).toFixed(1)}KB | ${targetUrl}`);
      return res.status(200)
        .set({
          'Content-Type': `image/${cachedFormat}`,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Cache-Status': 'HIT'
        })
        .send(cached);
    }

    const parsedTarget = new URL(targetUrl);
    const referer = getRefererForHost(parsedTarget.hostname, targetUrl);

    const headers = {
      'Referer': referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    };

    addLog(`🌐 FETCH | ${targetUrl}`);
    const networkStart = Date.now();
    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: s => s < 500,
      httpAgent: keepAliveAgent.http,
      httpsAgent: keepAliveAgent.https
    });
    const networkTime = Date.now() - networkStart;

    if (response.status === 403) {
      addLog(`🔁 403 RETRY | ${targetUrl}`);
      const retry = await axios.get(targetUrl, {
        responseType: 'arraybuffer',
        headers: { ...headers, 'Referer': 'https://mangabuddy.com/' },
        timeout: 15000,
        maxRedirects: 5,
        httpAgent: keepAliveAgent.http,
        httpsAgent: keepAliveAgent.https
      });
      if (retry.status !== 200) {
        addLog(`❌ HTTP ${retry.status} | ${targetUrl}`);
        return res.status(retry.status).send(`HTTP ${retry.status}`);
      }
      response.data = retry.data;
    } else if (response.status !== 200) {
      addLog(`❌ HTTP ${response.status} | ${targetUrl}`);
      return res.status(response.status).send(`HTTP ${response.status}`);
    }

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('image/')) {
      addLog(`❌ NOT IMAGE | ${targetUrl}`);
      return res.status(400).send('Not an image');
    }

    const inputBuffer = Buffer.from(response.data);
    const originalSize = inputBuffer.length;
    stats.requests++;
    stats.totalBytesReceived += originalSize;

    if (originalSize === 0) {
      addLog(`❌ EMPTY | ${targetUrl}`);
      return res.status(400).send('Empty image');
    }

    const isJpeg = contentType.includes('jpeg') || contentType.includes('jpg');

    // Skip compression for JPEG if jpg=1 mode (Tachiyomi) — re-encoding JPEG→JPEG loses quality for no gain
    if (isJpeg && useJpeg && !bw) {
      addLog(`⏭️ SKIP (JPEG passthrough) | ${(inputBuffer.length/1024).toFixed(1)}KB | ${targetUrl}`);
      try { imageCache.set(cacheKey, inputBuffer); } catch(e) {}
      return res.status(200).set({
        'Content-Type': 'image/jpeg',
        'Content-Length': inputBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Compression-Applied': 'no'
      }).send(inputBuffer);
    }

    const compressionResult = await processWithLimit(async () => {
      let finalBuffer, usedOriginal = false;
      let outputFormat = useJpeg ? 'jpeg' : 'webp';
      let outputBuffer;

      try {
        let pipeline = sharp(inputBuffer, {
          failOnError: false,
          sequentialRead: true,
          limitInputPixels: 268402689
        });

        if (bw) pipeline = pipeline.grayscale();

        if (!useJpeg) {
          try {
            const isPng = contentType.includes('png');
            const webpQuality = bw ? Math.max(65, quality - 15) : quality;

            if (isPng && !bw) {
              // PNG source: try lossless WebP first (usually 20-35% smaller than PNG)
              const losslessBuffer = await pipeline.clone().webp({
                lossless: true,
                effort: 6
              }).toBuffer();

              if (losslessBuffer.length < originalSize) {
                // Lossless wins — use it
                outputBuffer = losslessBuffer;
              } else {
                // Lossless didn't help, try near-lossless
                outputBuffer = await pipeline.clone().webp({
                  nearLossless: true,
                  quality: 85,
                  effort: 6
                }).toBuffer();
              }
            } else {
              // JPEG/WebP/other source: lossy WebP
              outputBuffer = await pipeline.clone().webp({
                quality: webpQuality,
                lossless: false,
                effort: 6,
                smartSubsample: true,
                reductionEffort: 6,
                alphaQuality: 75
              }).toBuffer();
            }
            outputFormat = 'webp';
          } catch (webpErr) {
            addLog(`🔄 WEBP FAIL → JPEG | ${webpErr.message.slice(0, 60)}`);
            useJpeg = true;
          }
        }

        if (useJpeg || !outputBuffer) {
          const jpegQuality = bw ? Math.max(60, quality - 20) : Math.max(65, quality - 15);
          outputBuffer = await pipeline.jpeg({
            quality: jpegQuality,
            mozjpeg: true,
            progressive: false,
            chromaSubsampling: '4:2:0',
            optimiseCoding: true,
            trellisQuantisation: true,
            overshootDeringing: true
          }).toBuffer();
          outputFormat = 'jpeg';
        }

        // Skip compression if saving less than 5% — not worth the quality loss
        const saving = (originalSize - outputBuffer.length) / originalSize;
        if (outputBuffer.length >= originalSize || saving < 0.05) {
          finalBuffer = inputBuffer;
          usedOriginal = true;
          outputFormat = getOriginalFormat(contentType);
        } else {
          finalBuffer = outputBuffer;
          stats.totalBytesSaved += (originalSize - outputBuffer.length);
        }

      } catch (err) {
        addLog(`⚠️ SHARP ERROR | ${err.message}`);
        finalBuffer = inputBuffer;
        usedOriginal = true;
        outputFormat = getOriginalFormat(contentType);
      }

      return { finalBuffer, usedOriginal, outputFormat };
    });

    const { finalBuffer, usedOriginal, outputFormat } = compressionResult;
    try { imageCache.set(cacheKey, finalBuffer); } catch(e) { addLog(`⚠️ CACHE SKIP | ${e.message}`); }
    recordPeriod(
      usedOriginal ? 0 : (originalSize - finalBuffer.length),
      originalSize,
      false
    );

    const elapsed = Date.now() - startTime;
    const procTime = elapsed - networkTime;
    const savedPercent = usedOriginal ? '0.0' : ((1 - finalBuffer.length / originalSize) * 100).toFixed(1);
    const status = usedOriginal ? '⚠️ ORIGINAL' : '✅ COMPRESSED';
    const logLine = `${status} | ${outputFormat.toUpperCase()} | ${(originalSize/1024).toFixed(1)}KB → ${(finalBuffer.length/1024).toFixed(1)}KB (${savedPercent}%) | net:${networkTime}ms proc:${procTime}ms | ${targetUrl}`;
    console.log(logLine);
    addLog(logLine);

    res.status(200)
      .set({
        'Content-Type': `image/${outputFormat}`,
        'Content-Length': finalBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Response-Time': `${elapsed}ms`,
        'X-Compression-Applied': usedOriginal ? 'no' : 'yes'
      })
      .send(finalBuffer);

  } catch (error) {
    stats.errors++;
    recordPeriod(0, 0, true);
    const msg = `❌ ERROR | ${error.message}`;
    console.error(msg);
    addLog(msg);
    res.status(500).send(`Server error: ${error.message}`);
  }
});

// ========================
// 📡 API Endpoints
// ========================

// Backup download
app.get('/backup', (req, res) => {
  saveStats();
  const backup = {
    stats,
    exportedAt: new Date().toISOString(),
    version: '1'
  };
  const json = JSON.stringify(backup, null, 2);
  res.set({
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="bwhero-backup-${new Date().toISOString().slice(0,10)}.json"`,
    'Content-Length': Buffer.byteLength(json)
  }).send(json);
});

// Restore from backup (POST JSON body)
app.use(express.json({ limit: '1mb' }));
app.post('/restore', (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.stats) return res.status(400).json({ error: 'Invalid backup file' });
    const s = data.stats;
    stats.requests = s.requests || 0;
    stats.cacheHits = s.cacheHits || 0;
    stats.totalBytesSaved = s.totalBytesSaved || 0;
    stats.totalBytesReceived = s.totalBytesReceived || 0;
    stats.errors = s.errors || 0;
    stats.startTime = s.startTime || Date.now();
    stats.periods   = s.periods   || {};
    saveStats();
    addLog(`📥 RESTORED | Stats restored from backup (${new Date(s.startTime).toISOString()})`);
    res.json({ ok: true, message: 'Stats restored' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    concurrency: { active: activeProcesses, max: MAX_CONCURRENT_PROCESSING, queued: processingQueue.length }
  });
});

app.get('/stats-json', (req, res) => {
  const uptimeSec = Math.floor((Date.now() - stats.startTime) / 1000);
  res.json({
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
    active: activeProcesses,
    queued: processingQueue.length,
    cacheKeys: imageCache.keys().length,
    istTime: nowIST().toISOString().replace('T', ' ').slice(0, 19) + ' IST',
    periods: {
      week:  stats.periods[getISTKey('week')]  || emptyPeriod(),
      month: stats.periods[getISTKey('month')] || emptyPeriod(),
      year:  stats.periods[getISTKey('year')]  || emptyPeriod(),
      weekKey:  getISTKey('week'),
      monthKey: getISTKey('month'),
      yearKey:  getISTKey('year')
    }
  });
});

app.get('/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const clientId = Date.now();
  liveLogs.clients.push({ id: clientId, res });

  // Send pm2 log history from file (survives restarts)
  const pm2Lines = readPm2Logs();
  if (pm2Lines.length > 0) {
    res.write(`data: ${JSON.stringify({ message: '── pm2 history ──' })}\n\n`);
    pm2Lines.forEach(line => {
      res.write(`data: ${JSON.stringify({ message: line })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ message: '── live ──' })}\n\n`);
  }

  // Send in-memory lines from current session
  liveLogs.lines.forEach(line => {
    res.write(`data: ${JSON.stringify({ message: line })}\n\n`);
  });

  req.on('close', () => {
    liveLogs.clients = liveLogs.clients.filter(c => c.id !== clientId);
  });
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Bandwidth Hero`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📡 Port:       ${PORT}`);
  console.log(`🖥️  Dashboard: http://localhost:${PORT}/`);
  console.log(`❤️  Health:    http://localhost:${PORT}/health`);
  console.log(`${'='.repeat(50)}\n`);

  addLog(`🚀 Bandwidth Hero started on port ${PORT}`);
  addLog(`⚡ Concurrency: ${MAX_CONCURRENT_PROCESSING} | WebP effort: 6 | Cache TTL: 6h`);
});
