/* Sky First Mail service worker. Email/API responses are deliberately never cached. */
const CACHE_NAME = 'sky-first-mail-static-v1';
const STATIC_ASSETS = [
  '/styles.css', '/stability.css', '/app.js', '/v3.js', '/v4.js', '/v5.js', '/v7.js',
  '/favicon.png', '/favicon-app.png', '/sky-first-logo.png', '/manifest.webmanifest', '/app-icon-192.png',
  '/app-icon-512.png', '/library/compose-library.json'
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(STATIC_ASSETS.map(async asset => {
      try { const response = await fetch(asset, { cache: 'reload' }); if (response.ok) await cache.put(asset, response); } catch {}
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('sky-first-mail-') && name !== CACHE_NAME) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const live = await fetch(request, { cache: 'no-store' });
        if (live.ok) { const cache = await caches.open(CACHE_NAME); await cache.put('/', live.clone()); }
        return live;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/')) || new Response('Sky First Mail đang ngoại tuyến. Kết nối mạng để tải dữ liệu hộp thư.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  if (!STATIC_ASSETS.includes(url.pathname) && !url.pathname.startsWith('/library/html/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME), cached = await cache.match(request);
    const network = fetch(request).then(async response => { if (response.ok) await cache.put(request, response.clone()); return response; });
    if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
    try { return await network; } catch { return new Response('Tài nguyên chưa có trong bộ nhớ đệm.', { status: 504 }); }
  })());
});
