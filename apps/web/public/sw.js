// RFDeck service worker: turns a push message into a notification.
//
// Deliberately minimal. This is not an offline shell or an app cache — that is
// the PWA work in the plan — it exists so an alert can reach a phone whose
// browser is closed. It caches nothing, so it can never serve a stale build.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = { title: 'RFDeck', body: '', tag: 'rfdeck', url: '/#/', severity: 'CRITICAL' };
  try { data = { ...data, ...event.data.json() }; } catch { /* a bare text push */ }

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    // One notification per channel: a flapping channel updates itself rather
    // than stacking twenty.
    tag: data.tag,
    renotify: true,
    // A CRITICAL alert is worth waking the phone for; anything less is not.
    requireInteraction: data.severity === 'CRITICAL',
    icon: './logo-mark-192.png',
    badge: './logo-mark-192.png',
    data: { url: data.url },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/#/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an open RFDeck tab if there is one rather than opening another.
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
