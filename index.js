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
