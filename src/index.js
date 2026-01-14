// Cloudflare Worker - Bandwidth Hero Proxy (Free Tier)
// No compression - just referer bypass and stats tracking

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Route handling
    if (url.pathname === '/health') return handleHealth();
    if (url.pathname === '/stats') return handleStats(env);
    if (url.pathname === '/') return handleImage(request, env, ctx);
    
    return new Response('Not Found', { status: 404 });
  }
};

// ========================
// 📊 Stats Handler
// ========================
async function handleStats(env) {
  const stats = await getStats(env);
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bandwidth Hero Stats</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 700px; margin: 0 auto; }
    .card {
      background: #2d3748;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 16px;
      color: white;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .rocket { font-size: 36px; }
    h1 { font-size: 28px; font-weight: 700; }
    .status-badge {
      background: #10b981;
      color: white;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 14px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid #4a5568;
    }
    .stat-row:last-child { border-bottom: none; }
    .stat-label {
      color: #cbd5e0;
      font-size: 14px;
    }
    .stat-value {
      color: #60a5fa;
      font-weight: 600;
      font-family: 'Courier New', monospace;
      font-size: 14px;
    }
    .setup-code {
      background: #1a202c;
      color: #10b981;
      padding: 12px;
      border-radius: 8px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      overflow-x: auto;
      margin: 8px 0;
      word-break: break-all;
    }
    .warning {
      background: #f59e0b;
      color: #1a202c;
      padding: 12px;
      border-radius: 8px;
      margin-top: 8px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="rocket">🚀</div>
        <div>
          <h1>Bandwidth Hero</h1>
          <div class="status-badge">
            <span>●</span> Free Tier (No Compression)
          </div>
        </div>
      </div>

      <div class="stat-row">
        <span class="stat-label">Total Requests</span>
        <span class="stat-value">${stats.requests.toLocaleString()}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Successful</span>
        <span class="stat-value">${stats.success}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Errors</span>
        <span class="stat-value">${stats.errors}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">403 Retries</span>
        <span class="stat-value">${stats.retries}</span>
      </div>
    </div>

    <div class="card">
      <div style="font-size: 18px; margin-bottom: 16px;">📱 Tachiyomi Setup</div>
      <div class="setup-code">https://YOUR-WORKER.workers.dev/?url=</div>
      <div class="warning">⚠️ Free tier: No compression, only referer bypass</div>
    </div>

    <div class="card" style="background: #1a202c;">
      <div style="color: #cbd5e0; font-size: 13px; line-height: 1.6;">
        <strong style="color: #60a5fa;">Features:</strong><br>
        • Referer header bypass<br>
        • Automatic 403 retry logic<br>
        • Cloudflare global edge network<br>
        • Automatic caching (1 hour)<br>
        • Smart referer handling for manga sites
      </div>
    </div>
  </div>

  <script>
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

// ========================
// ❤️ Health Check
// ========================
function handleHealth() {
  return new Response(JSON.stringify({
    status: 'ok',
    platform: 'cloudflare-workers',
    tier: 'free',
    compression: 'disabled',
    timestamp: new Date().toISOString()
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ========================
// 🖼️ Image Handler
// ========================
async function handleImage(request, env, ctx) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl) {
    return new Response('Missing ?url= parameter', { status: 400 });
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const referer = getRefererForHost(parsedTarget.hostname, targetUrl);

    // Debug logging
    console.log('Target URL:', targetUrl);
    console.log('Hostname:', parsedTarget.hostname);
    console.log('Generated Referer:', referer);

    // Fetch original image
    const response = await fetch(targetUrl, {
      headers: {
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 3600
      }
    });

    console.log('Response Status:', response.status);
    console.log('Content-Type:', response.headers.get('content-type'));

    if (!response.ok) {
      // Retry with different referer on 403
      if (response.status === 403) {
        console.log('403 detected, retrying with mangabuddy.com referer');
        await incrementStat(env, 'retries');
        
        const retryResponse = await fetch(targetUrl, {
          headers: {
            'Referer': 'https://mangabuddy.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          },
          cf: {
            cacheEverything: true,
            cacheTtl: 3600
          }
        });
        
        console.log('Retry Response Status:', retryResponse.status);
        
        if (!retryResponse.ok) {
          await incrementStat(env, 'errors');
          return new Response(`HTTP ${retryResponse.status} - Failed even after retry`, { 
            status: retryResponse.status 
          });
        }
        
        await incrementStat(env, 'requests');
        await incrementStat(env, 'success');
        
        return proxyImage(retryResponse);
      }
      
      await incrementStat(env, 'errors');
      return new Response(`HTTP ${response.status}`, { status: response.status });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('image/')) {
      await incrementStat(env, 'errors');
      return new Response('Not an image', { status: 400 });
    }

    await incrementStat(env, 'requests');
    await incrementStat(env, 'success');

    return proxyImage(response);

  } catch (error) {
    console.error('Error:', error.message, error.stack);
    await incrementStat(env, 'errors');
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

// ========================
// 🔄 Proxy Image (No Compression)
// ========================
async function proxyImage(response) {
  const imageBuffer = await response.arrayBuffer();
  const imageSize = imageBuffer.byteLength;
  
  console.log('Image Size:', imageSize, 'bytes');

  return new Response(imageBuffer, {
    headers: {
      'Content-Type': response.headers.get('content-type'),
      'Content-Length': imageSize.toString(),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Proxy-Mode': 'passthrough',
      'X-Image-Size': imageSize.toString(),
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ========================
// 🌐 Referer Helper
// ========================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  // MangaBuddy CDN - Updated regex to handle /res/manga/ path
  if (/^s\d+\.mbcdnsa[a-z]?\.org$/.test(host)) {
    const match = targetUrl.match(/\/(?:res\/)?manga\/([^/]+)\/chapter-(\d+)/i);
    const referer = match
      ? `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`
      : "https://mangabuddy.com/";
    
    console.log('MangaBuddy referer generated:', referer);
    return referer;
  }

  if (host.includes("likemanga") || host.includes("1kmgv") || host.includes("like1.") || host.includes("mangayy")) {
    return "https://likemanga.ink/";
  }

  const map = {
    mgcdn: "https://res.mgcdn.xyz/",
    mbbcdn: "https://res.mgcdn.xyz/",
    mangapill: "https://mangapill.com/",
    readdetectiveconan: "https://mangapill.com/",
    hentaifox: "https://hentaifox.com/",
    nhentai: "https://nhentai.net/"
  };

  for (const [k, v] of Object.entries(map)) {
    if (host.includes(k)) {
      console.log(`Matched referer for ${k}:`, v);
      return v;
    }
  }

  const defaultReferer = `https://${hostname}/`;
  console.log('Using default referer:', defaultReferer);
  return defaultReferer;
}

// ========================
// 📊 Stats Management (KV)
// ========================
async function getStats(env) {
  if (!env.STATS) {
    return { requests: 0, success: 0, errors: 0, retries: 0 };
  }

  const stats = await env.STATS.get('stats', 'json');
  return stats || { requests: 0, success: 0, errors: 0, retries: 0 };
}

async function incrementStat(env, key, value = 1) {
  if (!env.STATS) return;

  const stats = await getStats(env);
  stats[key] = (stats[key] || 0) + value;
  
  // Store stats (with 60 second debounce to reduce KV writes)
  await env.STATS.put('stats', JSON.stringify(stats), {
    expirationTtl: 86400 * 30 // Keep for 30 days
  });
}
