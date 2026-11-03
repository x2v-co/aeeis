// AEEIS service worker: makes the app installable and shows S1 pushes (§9.4) when no page is open.
// It caches nothing: AEEIS needs the server to be useful, and stale approvals would be worse than none.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only */ });

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'AEEIS：有事要你决定';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = pages.find(client => new URL(client.url).origin === self.location.origin);
    if (page) { await page.focus(); page.postMessage({ type: 'aeeis.open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
