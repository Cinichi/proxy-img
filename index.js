// Simple Image Proxy for Cloudflare Workers
// No compression version

export default {
  async fetch(request, env, ctx) {
    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    // Validate target URL
    if (!targetUrl) {
      return new Response('Missing ?url= parameter', { status: 400 });
    }

    // Validate URL format
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch (e) {
      return redirect(targetUrl);
    }

    try {
      // Build request headers
      const proxyHeaders = new Headers();
      
      // Copy safe headers from original request
      const safeHeaders = ['cookie', 'dnt', 'referer'];
      safeHeaders.forEach(header => {
        const value = request.headers.get(header);
        if (value) proxyHeaders.set(header, value);
      });

      // Add proxy-specific headers
      proxyHeaders.set('user-agent', 'Bandwidth-Hero Proxy');
      proxyHeaders.set('x-forwarded-for', request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '');
      proxyHeaders.set('via', '1.1 bandwidth-hero');
      proxyHeaders.set('accept-encoding', 'gzip, deflate, br');

      // Fetch the target URL
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: proxyHeaders,
        redirect: 'follow',
        cf: {
          cacheTtl: 3600,
          cacheEverything: true,
        }
      });

      // Redirect on error status codes
      if (!response.ok && response.status >= 400) {
        return redirect(targetUrl);
      }

      // Build response with original headers
      const responseHeaders = new Headers(response.headers);
      
      // Override content-encoding to identity (no compression)
      responseHeaders.set('content-encoding', 'identity');
      
      // Add CORS headers for browser access
      responseHeaders.set('access-control-allow-origin', '*');
      responseHeaders.set('access-control-allow-methods', 'GET');
      
      // Remove headers that might cause issues
      responseHeaders.delete('content-security-policy');
      responseHeaders.delete('x-frame-options');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });

    } catch (error) {
      console.error('Proxy error:', error.message);
      return redirect(targetUrl);
    }
  }
};

// Helper function to redirect to original URL
function redirect(url) {
  return new Response(null, {
    status: 302,
    headers: {
      'location': url,
      'cache-control': 'no-cache'
    }
  });
                       }
