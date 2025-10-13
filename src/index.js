export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response('Missing ?url= parameter', { status: 400 });
    }

    try {
      new URL(targetUrl);
    } catch (e) {
      return redirect(targetUrl);
    }

    try {
      const response = await fetch(targetUrl, {
        cf: {
          cacheTtl: 86400,        // Cache for 24 hours (longer for manhwa)
          cacheEverything: true,
          polish: 'lossless',     // Lossless compression (keeps quality)
        }
      });

      if (!response.ok && response.status >= 400) {
        return redirect(targetUrl);
      }

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('access-control-allow-origin', '*');
      responseHeaders.set('access-control-allow-methods', 'GET');
      responseHeaders.set('cache-control', 'public, max-age=86400'); // Cache in browser
      responseHeaders.delete('content-security-policy');
      responseHeaders.delete('x-frame-options');

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders
      });

    } catch (error) {
      console.error('Proxy error:', error.message);
      return redirect(targetUrl);
    }
  }
};

function redirect(url) {
  return new Response(null, {
    status: 302,
    headers: {
      'location': url,
      'cache-control': 'no-cache'
    }
  });
}
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
