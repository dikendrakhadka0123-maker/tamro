/* TAMRO app-shell caching — add this as the FIRST line of your existing sw.js:
 *     importScripts('./sw-shell.js');
 * It does not touch push handling. It only:
 *  - opens the app instantly / shows the last-good page when the phone is offline
 *    (network-first, so a new deploy is still picked up immediately),
 *  - caches Google Fonts and /icons/ (stale-while-revalidate).
 * Supabase and every other cross-origin API call is left completely alone.
 */
const TAMRO_SHELL_CACHE = 'tamro-shell-v1';

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('tamro-shell-') && k !== TAMRO_SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Page loads: network first, fall back to the last good copy (same HTML serves every ?role= URL).
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const c = await caches.open(TAMRO_SHELL_CACHE);
          c.put('./shell', res.clone());
        }
        return res;
      } catch (err) {
        const c = await caches.open(TAMRO_SHELL_CACHE);
        const cached = await c.match('./shell');
        return cached || new Response('<h2 style="font-family:sans-serif;text-align:center;margin-top:30vh">No internet connection</h2>', { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // Fonts + icons: stale-while-revalidate.
  const isStatic = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' ||
                   (url.origin === self.location.origin && url.pathname.indexOf('/icons/') !== -1);
  if (isStatic) {
    e.respondWith((async () => {
      const c = await caches.open(TAMRO_SHELL_CACHE);
      const cached = await c.match(req);
      const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || net;
    })());
  }
});
