// Very small service worker: network-first, falling back to the last cached
// copy when offline. Only meant to keep the public results pages viewable
// (with last-seen data) if a visitor briefly loses signal — not a full
// offline app.
const CACHE_NAME = 'lottery-site-v3-public-only';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['/', '/css/style.css', '/favicon.svg']))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Only public pages/assets may be cached. Never cache authenticated pages.
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/account') || url.pathname === '/login' || url.pathname === '/recover' || url.pathname.startsWith('/notifications') || url.pathname.startsWith('/lang/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});


self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'Result notification', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Result notification', {
      body: data.body || 'A result matching one of your followed numbers has been published.',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url: data.url || '/account' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/account';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if ('focus' in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    return clients.openWindow(url);
  }));
});
