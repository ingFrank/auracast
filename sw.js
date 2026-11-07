const CACHE_NAME = 'auracast-v22';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './catalogo-local.js',
  './fonts/inter-latin.woff2',
  './fonts/inter-latin-ext.woff2'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of APP_SHELL) {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res && res.ok) {
            await cache.put(url, res);
          }
        } catch (e) {}
      }
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function fetchWithFastTimeout(request, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);

    // Force fresh fetch for HTML/CSS/JS so updates never get stuck on mobile
    // Use request.url (string) because passing a Request with mode="navigate" + RequestInit throws TypeError in Chromium!
    fetch(request.url, { signal: controller.signal, cache: 'no-cache' })
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Do not intercept audio streaming or Range requests (let browser handle 206 Partial Content natively)
  if (
    event.request.headers.has('range') ||
    url.pathname.startsWith('/audios/') ||
    url.pathname.includes('/AUDIOS/') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  event.respondWith(
    fetchWithFastTimeout(event.request, 4500)
      .then(response => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone).catch(() => {});
            // Also update base path without query string so ignoreSearch always returns latest
            const cleanUrl = new URL(event.request.url);
            cleanUrl.search = '';
            cache.put(cleanUrl.toString(), response.clone()).catch(() => {});
          }).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html', { ignoreSearch: true });
        }
        return new Response('', { status: 408 });
      })
  );
});
