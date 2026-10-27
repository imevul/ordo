// Ordo's service worker: makes the app installable, keeps its shell and built assets so it starts
// without a connection, and shows push notifications. The API is never cached (the workspace's
// offline copy lives in IndexedDB; see packages/sync).

const CACHE = 'ordo-shell-v2';

/** Every built file, from the build's precache.json (absent in development). */
async function precacheList() {
  try {
    const res = await fetch('/precache.json', { cache: 'no-store' });
    return res.ok ? (await res.json()).files : null;
  } catch {
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const files = await precacheList();
      if (files) {
        const cache = await caches.open(CACHE);
        // The page and every chunk, so any screen opens offline; one failure isn't fatal.
        await Promise.all(['/', ...files].map((f) => cache.add(f).catch(() => {})));
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // Files of earlier builds go; their names change with every build.
      const files = await precacheList();
      if (files) {
        const keep = new Set(files);
        const cache = await caches.open(CACHE);
        for (const request of await cache.keys()) {
          const path = new URL(request.url).pathname;
          if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(request);
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // The page itself: fresh when online, the last good copy when not.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Built files have content hashes in their names: once fetched, they never change.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Ordo', {
      body: data.body || '',
      tag: data.tag,
      data: { url: data.url || '/' },
      icon: '/icon-192.png',
      badge: '/badge-96.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.navigate(url).then((w) => (w ?? open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
