// ============================================================
// sw.js — minimal service worker whose only job is Web Push.
// No offline caching — the dashboard already reads/writes
// Supabase directly and isn't meant to work offline.
// ============================================================

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || "Finn's Dashboard";
  const options = {
    body: data.body || '',
    icon: '/apple-touch-icon.png',
    badge: '/apple-touch-icon.png',
    data: { url: data.url || '/', token: data.token || null },
  };
  // Buttons on the notification itself, so a tick never needs the app
  // opened. `data.token` authorises exactly one write (see /api/tick).
  if (Array.isArray(data.actions) && data.actions.length) {
    options.actions = data.actions.slice(0, 2);   // 2 is all most platforms show
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = event.notification.data || {};
  const url = info.url || '/';

  // A button press writes straight through the API and never opens a
  // window. Anything else (tapping the body) opens the dashboard.
  if (event.action && info.token) {
    event.waitUntil(
      fetch('/api/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: info.token }),
      })
        .then((r) => r.ok
          ? self.registration.showNotification('Logged', { body: 'Clean day recorded.', icon: '/apple-touch-icon.png', badge: '/apple-touch-icon.png', tag: 'tick-ok' })
          : self.registration.showNotification('Did not save', { body: 'Open the dashboard and tick it there.', icon: '/apple-touch-icon.png', badge: '/apple-touch-icon.png', tag: 'tick-fail', data: { url: '/index.html' } }))
        .catch(() => self.registration.showNotification('Did not save', {
          body: 'No connection. Open the dashboard and tick it there.',
          icon: '/apple-touch-icon.png', badge: '/apple-touch-icon.png', tag: 'tick-fail', data: { url: '/index.html' },
        }))
    );
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
