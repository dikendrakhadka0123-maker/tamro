// TAMRO service worker — order alerts that are hard to miss.
// Handles push messages for riders, managers, admin and customers.
const V = 'push-log-3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// The app asks "which version are you?" (used by the "Test my alerts" button)
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'ping' && e.ports && e.ports[0]) e.ports[0].postMessage({ v: V });
});

async function logPush(o) {
  try {
    const c = await caches.open('tamro-push-log');
    await c.put('/__lastpush', new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* ignore */ }
}

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { try { d = { body: event.data.text() }; } catch (__) { d = {}; } }
  const urgent = !!d.urgent;
  const title = d.title || 'TAMRO';
  const tag = d.tag || ('tamro-' + Date.now());
  const opts = {
    body: d.body || '',
    tag: tag,
    renotify: true,                              // ring again even if a notification with this tag is already showing
    requireInteraction: urgent || !!d.requireInteraction, // stays on screen until tapped (new orders)
    vibrate: Array.isArray(d.vibrate) ? d.vibrate : (urgent ? [600, 200, 600, 200, 600, 200, 900] : [200, 100, 200]),
    silent: false,
    timestamp: Date.now(),
    data: { url: d.url || './', orderId: d.orderId || null },
  };
  if (d.icon) opts.icon = d.icon;
  if (d.badge) opts.badge = d.badge;
  if (d.image) opts.image = d.image;

  event.waitUntil((async () => {
    const t = Date.now();
    try {
      // Always show a notification (iPhone removes the registration if a push is received without one)
      await self.registration.showNotification(title, opts);
      await logPush({ t: t, ok: true, tag: tag, title: title });
    } catch (err) {
      await logPush({ t: t, ok: false, err: String(err), tag: tag });
    }
    // If the app is open, tell it right away so it can play its loud in-app alarm
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      list.forEach((c) => c.postMessage({ type: 'new-order-push', urgent: urgent, orderId: d.orderId || null }));
    } catch (e) { /* ignore */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const url = new URL(target, self.registration.scope).href;
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      try {
        if (c.url.split('#')[0].split('?')[0] === url.split('#')[0].split('?')[0] && 'focus' in c) {
          await c.focus();
          if ('navigate' in c && c.url !== url) { try { await c.navigate(url); } catch (e) { /* ignore */ } }
          return;
        }
      } catch (e) { /* ignore */ }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

// The phone's push service replaced this device's registration: ask the app to register again
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      list.forEach((c) => c.postMessage({ type: 'resubscribe' }));
    } catch (e) { /* ignore */ }
  })());
});
