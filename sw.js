// TAMRO Delivery — Service Worker
// Handles Web Push events so the delivery boy gets a real OS notification
// (sound + vibration + banner) even when the app/tab is closed or the phone is locked.

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

  const title = data.title || '🔔 New Order — TAMRO';
  const icon = data.icon || 'https://ui-avatars.com/api/?name=DB&background=1a1a2e&color=fff&size=512&bold=true&font-size=0.4';

  const options = {
    body: data.body || 'A new order is waiting for pickup!',
    icon: icon,
    badge: icon,
    vibrate: [400, 150, 400, 150, 400, 150, 700],
    tag: 'tamro-new-order',
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || './?dboy=1' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './?dboy=1';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList){
      for (const client of clientList) {
        if (client.url.indexOf('dboy=1') !== -1 && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
