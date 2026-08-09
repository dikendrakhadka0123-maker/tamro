// TAMRO Delivery — Service Worker
// Handles Web Push events for two audiences:
//  1) Delivery boys — real-time new-order alerts (sound + vibration + banner)
//     even when the app/tab is closed or the phone is locked.
//  2) Customers — promotional notifications (e.g. "EXTRA 60% OFF" style deals)
//     sent on-demand by admin, same mechanism, tuned to be less intrusive.
// Which one is which is decided entirely by the payload sent from the
// server (type/tag/requireInteraction/image) — this file doesn't need to
// know or care who it's for.

self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function(event){
  let data = {};
  try{
    data = event.data ? event.data.json() : {};
  }catch(e){
    data = { title: '🔔 New Order — TAMRO', body: event.data ? event.data.text() : 'A new order is waiting!' };
  }

  const isPromo = data.type === 'promo';
  const title = data.title || (isPromo ? '🎁 TAMRO' : '🔔 New Order — TAMRO');
  const icon = data.icon || 'https://ui-avatars.com/api/?name=DB&background=1a1a2e&color=fff&size=512&bold=true&font-size=0.4';

  const options = {
    body: data.body || 'A new order is waiting for pickup!',
    icon: icon,
    badge: icon,
    // Order alerts: strong, repeats until dismissed, needs your attention
    // right away. Promo pushes: one gentle buzz, doesn't force interaction
    // — matches how ordinary shopping-app deal notifications behave.
    vibrate: data.vibrate || (isPromo ? [200, 100, 200] : [400, 150, 400, 150, 400, 150, 700]),
    tag: data.tag || (isPromo ? 'tamro-promo' : 'tamro-new-order'),
    renotify: data.renotify !== undefined ? data.renotify : true,
    requireInteraction: data.requireInteraction !== undefined ? data.requireInteraction : !isPromo,
    // Promo notifications go to customers → must land on the customer app
    // (?customer=1), never the bare domain — the bare domain is now the
    // admin gate and shows a blank "nothing here" screen to anyone without
    // the admin key. Order alerts still go to the delivery boy app as before.
    data: { url: data.url || (isPromo ? './?customer=1' : './?dboy=1') }
  };
  // Rich thumbnail image (like the Daraz-style promo banner) — only added
  // when provided, since order alerts don't need/want one.
  if (data.image) options.image = data.image;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './?customer=1';
  // A short fragment of the target used to detect "is a matching tab
  // already open" — e.g. 'dboy=1' for order alerts, 'customer=1' for a
  // general promo linking to the customer app.
  const matchFragment = targetUrl.indexOf('dboy=1') !== -1 ? 'dboy=1' : (targetUrl.indexOf('customer=1') !== -1 ? 'customer=1' : null);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList){
      // Prefer an already-open tab that matches this notification's context.
      if (matchFragment) {
        for (const client of clientList) {
          if (client.url.indexOf(matchFragment) !== -1 && 'focus' in client) {
            return client.focus();
          }
        }
      }
      // Otherwise, reuse any already-open tab of ours if we can navigate it,
      // so we don't pile up duplicate tabs every time a promo is tapped.
      for (const client of clientList) {
        if ('focus' in client && 'navigate' in client) {
          return client.focus().then(function(){ return client.navigate(targetUrl); });
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
