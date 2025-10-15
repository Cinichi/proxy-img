export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const noPolish = url.searchParams.get('nopolish') === '1'; // Optional: ?nopolish=1 to skip Polish for testing
    const preloadFirst = url.searchParams.get('preload') === '1'; // NEW: ?preload=1 to force preload critical images

    if (!targetUrl) {
      return new Response('Missing ?url= parameter', { status: 400 });
    }

    try {
      new URL(targetUrl);
    } catch (e) {
      return redirect(targetUrl);
    }

    try {
      // Start timing for logging
      const startTime = Date.now();

      const cfOptions = {
        cacheTtl: 86400,        // Cache for 24 hours
        cacheEverything: true,
        minify: {               // Minify HTML/JS/CSS for faster parsing
          js: true,
          css: true,
          html: true
        }
      };

      // Conditionally apply Polish (skip for speed testing or non-images)
      if (!noPolish) {
        cfOptions.polish = 'lossless'; // Keep quality, but test without via ?nopolish=1
      }

      const response = await fetch(targetUrl, { cf: cfOptions });

      if (!response.ok && response.status >= 400) {
        return redirect(targetUrl);
      }

      let finalResponse;
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.startsWith('text/html')) {
        // Transform HTML for image-heavy sites: Smart lazy loading + optional preload
        const html = await response.text();
        const optimizedHtml = addSmartLazyLoading(html, preloadFirst);
        finalFinalResponse = new Response(optimizedHtml, {
          status: response.status,
          headers: getModifiedHeaders(response.headers)
        });
      } else {
        // For images/CSS/JS: Stream directly
        finalResponse = new Response(response.body, {
          status: response.status,
          headers: getModifiedHeaders(response.headers)
        });
      }

      // Log performance (view in CF dashboard logs)
      const endTime = Date.now();
      console.log(`Proxied ${targetUrl} in ${endTime - startTime}ms (cache hit: ${response.cf?.cacheStatus || 'miss'})`);

      return finalResponse;

    } catch (error) {
      console.error('Proxy error:', error.message);
      return redirect(targetUrl);
    }
  }
};

function getModifiedHeaders(originalHeaders) {
  const headers = new Headers(originalHeaders);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET');
  headers.set('cache-control', 'public, max-age=86400'); // Aggressive browser caching
  headers.delete('content-security-policy');
  headers.delete('x-frame-options');
  // Add ETag for better caching if not present
  if (!headers.has('etag')) {
    headers.set('etag', `"proxy-${Date.now()}"`);
  }
  return headers;
}

function addSmartLazyLoading(html, preloadFirst = false) {
  let imgCount = 0;
  let preloadTags = '';
  
  // Use regex to process <img> tags sequentially
  return html.replace(
    /<img([^>]*?)>/gi,
    (match, attrs) => {
      imgCount++;
      let newAttrs = attrs;
      
      // Skip lazy for first 5 images (first page panels) to ensure fast load
      if (imgCount <= 5) {
        if (preloadFirst) {
          // Extract src for preload (add to <head>)
          const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
          if (srcMatch) {
            preloadTags += `<link rel="preload" as="image" href="${srcMatch[1]}">\n`;
          }
        }
        // No lazy; maybe add fetchpriority="high" for first image
        if (imgCount === 1 && !attrs.includes('fetchpriority=')) {
          newAttrs += ' fetchpriority="high"';
        }
      } else if (!attrs.includes('loading=') && !attrs.includes('data-src=')) {
        // Lazy load the rest
        newAttrs += ' loading="lazy"';
      }
      
      return `<img${newAttrs}>`;
    }
  ) + (preloadTags ? `<head>${preloadTags}</head>` : ''); // Append preloads if enabled (hacky; assumes <head> exists)
}

function redirect(url) {
  return new Response(null, {
    status: 302,
    headers: {
      'location': url,
      'cache-control': 'no-cache'
    }
  });
                                          }
