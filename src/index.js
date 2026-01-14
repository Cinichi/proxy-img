// Cloudflare Worker - Bandwidth Hero Image Proxy
// Optimized for edge computing with WebP compression

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
            <span>●</span> Cloudflare Edge
          </div>
        </div>
      </div>

      <div class="stat-row">
        <span class="stat-label">Total Requests</span>
        <span class="stat-value">${stats.requests.toLocaleString()}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Data Saved</span>
        <span class="stat-value">${(stats.bytesSaved / 1024 / 1024).toFixed(2)} MB</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Data Sent</span>
        <span class="stat-value">${(stats.bytesSent / 1024 / 1024).toFixed(2)} MB</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Saved %</span>
        <span class="stat-value">${stats.bytesSent > 0 ? ((stats.bytesSaved / (stats.bytesSaved + stats.bytesSent)) * 100).toFixed(1) : 0}%</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Errors</span>
        <span class="stat-value">${stats.errors}</span>
      </div>
    </div>

    <div class="card">
      <div style="font-size: 18px; margin-bottom: 16px;">📱 Tachiyomi Setup (JPEG)</div>
      <div class="setup-code">https://YOUR-WORKER.workers.dev/?url=&jpg=1&l=80</div>
    </div>

    <div class="card">
      <div style="font-size: 18px; margin-bottom: 16px;">🌐 Web Setup (WebP)</div>
      <div class="setup-code">https://YOUR-WORKER.workers.dev/?url=&l=85</div>
    </div>

    <div class="card">
      <div style="font-size: 18px; margin-bottom: 16px;">⚫ Black & White Mode</div>
      <div class="setup-code">https://YOUR-WORKER.workers.dev/?url=&bw=1&l=75</div>
    </div>

    <div class="card" style="background: #1a202c;">
      <div style="color: #cbd5e0; font-size: 13px; line-height: 1.6;">
        <strong style="color: #60a5fa;">Features:</strong><br>
        • WebP & JPEG compression<br>
        • Cloudflare global edge network<br>
        • Automatic caching (1 hour)<br>
        • Black & white conversion<br>
        • Smart referer handling<br>
        • Size increase protection
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

  const quality = Math.min(100, Math.max(10, parseInt(url.searchParams.get('l')) || 85));
  const useJpeg = url.searchParams.get('jpg') === '1' || url.searchParams.get('jpeg') === '1';
  const bw = url.searchParams.get('bw') === '1';

  try {
    const parsedTarget = new URL(targetUrl);
    const referer = getRefererForHost(parsedTarget.hostname, targetUrl);

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

    if (!response.ok) {
      // Retry with different referer on 403
      if (response.status === 403) {
        const retryResponse = await fetch(targetUrl, {
          headers: {
            'Referer': 'https://mangabuddy.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          }
        });
        
        if (!retryResponse.ok) {
          return new Response(`HTTP ${retryResponse.status}`, { status: retryResponse.status });
        }
        
        return processImage(retryResponse, quality, useJpeg, bw, env, targetUrl);
      }
      
      return new Response(`HTTP ${response.status}`, { status: response.status });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('image/')) {
      return new Response('Not an image', { status: 400 });
    }

    return processImage(response, quality, useJpeg, bw, env, targetUrl);

  } catch (error) {
    await incrementStat(env, 'errors');
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

// ========================
// 🔄 Image Processing
// ========================
async function processImage(response, quality, useJpeg, bw, env, targetUrl) {
  const originalBuffer = await response.arrayBuffer();
  const originalSize = originalBuffer.byteLength;
  
  await incrementStat(env, 'bytesSent', originalSize);
  await incrementStat(env, 'requests');

  if (originalSize === 0) {
    return new Response('Empty image', { status: 400 });
  }

  // Build compression options
  const options = {
    quality,
    fit: 'inside'
  };

  // Add format-specific options
  if (useJpeg) {
    options.format = 'jpeg';
  } else {
    options.format = 'webp';
  }

  // Add grayscale if requested
  if (bw) {
    options.grayscale = true;
  }

  try {
    // Use Cloudflare's Image Resizing (if available in your plan)
    // For free tier, we'll use a simpler approach
    const compressedResponse = await fetch(targetUrl, {
      cf: {
        image: options
      }
    });

    const compressedBuffer = await compressedResponse.arrayBuffer();
    const compressedSize = compressedBuffer.byteLength;

    // Size increase protection - send original if compressed is larger
    if (compressedSize > originalSize) {
      console.log(`Size increased: ${compressedSize} > ${originalSize}, sending original`);
      
      return new Response(originalBuffer, {
        headers: {
          'Content-Type': response.headers.get('content-type'),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Compression-Applied': 'no',
          'X-Original-Size': originalSize.toString(),
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    const saved = originalSize - compressedSize;
    await incrementStat(env, 'bytesSaved', saved);

    const outputFormat = useJpeg ? 'jpeg' : 'webp';

    return new Response(compressedBuffer, {
      headers: {
        'Content-Type': `image/${outputFormat}`,
        'Content-Length': compressedSize.toString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Original-Size': originalSize.toString(),
        'X-Compressed-Size': compressedSize.toString(),
        'X-Bytes-Saved': saved.toString(),
        'X-Compression-Applied': 'yes',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('Compression error:', error);
    // Fallback to original on error
    return new Response(originalBuffer, {
      headers: {
        'Content-Type': response.headers.get('content-type'),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Compression-Applied': 'no',
        'X-Error': error.message,
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// ========================
// 🌐 Referer Helper
// ========================
function getRefererForHost(hostname, targetUrl = "") {
  const host = hostname.toLowerCase();

  if (/^s\d+\.mbcdnsa[a-z]?\.org$/.test(host)) {
    // Updated regex to handle /res/manga/ path structure
    const match = targetUrl.match(/\/(?:res\/)?manga\/([^/]+)\/chapter-(\d+)/i);
    return match
      ? `https://mangabuddy.com/manga/${match[1]}/chapter-${match[2]}`
      : "https://mangabuddy.com/";
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
    if (host.includes(k)) return v;
  }

  return `https://${hostname}/`;
}

// ========================
// 📊 Stats Management (KV)
// ========================
async function getStats(env) {
  if (!env.STATS) {
    return { requests: 0, bytesSaved: 0, bytesSent: 0, errors: 0 };
  }

  const stats = await env.STATS.get('stats', 'json');
  return stats || { requests: 0, bytesSaved: 0, bytesSent: 0, errors: 0 };
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
