/* TAMRO native bridge — only does anything inside the Capacitor Android app (delivery boy).
 * In a normal browser / PWA / TWA, window.Capacitor is missing and this file is a no-op.
 *
 * What it adds: location that KEEPS UPDATING when the phone is locked or the app is in the
 * background (a web page's timers + GPS stop in that state). It writes to the same
 * dboy_locations table the admin map already reads, so no backend change is needed.
 *
 * Load it with:  <script src="native-bridge.js"></script>   (already added to index.html)
 * Plugin:        npm i @capacitor-community/background-geolocation
 */
(function () {
  if (!window.Capacitor) return;
  var BG = window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation;
  if (!BG) { console.log('native-bridge: BackgroundGeolocation plugin not installed'); return; }

  var watcherId = null, lastFix = null, heartbeat = null;

  function upsert(fix) {
    // dbLoggedInName, SB_URL, SB_KEY are globals declared by index.html
    var payload = {
      dboy_name: dbLoggedInName,
      lat: Number(fix.latitude).toFixed(6),
      lng: Number(fix.longitude).toFixed(6),
      accuracy: Math.round(fix.accuracy || 0),
      updated_at: new Date().toISOString()
    };
    var headers = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json',
                    Accept: 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
    return fetch(SB_URL + '/rest/v1/dboy_locations', { method: 'POST', headers: headers, body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.ok) return;
        delete payload.accuracy; // older tables without the accuracy column
        return fetch(SB_URL + '/rest/v1/dboy_locations', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
      }).catch(function () {});
  }

  function start() {
    if (watcherId !== null) return;
    watcherId = 'pending';
    BG.addWatcher({
      backgroundTitle: 'TAMRO Delivery is on duty',
      backgroundMessage: 'Sharing your live location with TAMRO while you are logged in.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 20
    }, function (loc, err) {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') {
          if (typeof dbShowLocationBanner === 'function') dbShowLocationBanner(true);
          if (window.confirm('TAMRO needs location access "Allow all the time" to share your position while the phone is locked. Open settings?')) BG.openSettings();
        }
        return;
      }
      if (!loc || loc.accuracy > 150) return;
      if (typeof dbShowLocationBanner === 'function') dbShowLocationBanner(false);
      lastFix = loc;
      upsert(loc);
    }).then(function (id) {
      watcherId = id;
      window._tamroNativeLocation = true;           // tells index.html to stop its own (foreground-only) location timer
    });
    // A rider standing still produces no movement events — refresh the timestamp so the admin map stays "fresh".
    heartbeat = setInterval(function () { if (lastFix && dbLoggedInName) upsert(lastFix); }, 60000);
  }

  function stop() {
    if (watcherId && watcherId !== 'pending') BG.removeWatcher({ id: watcherId });
    watcherId = null; lastFix = null; window._tamroNativeLocation = false;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  // Follow the delivery boy's login state
  setInterval(function () {
    var loggedIn = typeof dbLoggedInName !== 'undefined' && !!dbLoggedInName;
    if (loggedIn && watcherId === null) start();
    if (!loggedIn && watcherId !== null) stop();
  }, 2000);

  // ───────────────────────── FCM PUSH (delivery boy + manager) ─────────────────────────
  // Replaces Web Push inside the Android app. The FCM token is saved in the SAME tables as before
  // (dboy_push_subs / manager_push_subs) with endpoint = 'fcm:<token>' and subscription = {fcm:true, token},
  // so the existing unique constraints keep working. Server side: supabase/functions/send-fcm-push.
  var PN = window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
  var qs = new URLSearchParams(window.location.search);
  var cfg = qs.get('dboy') === '1'
    ? { table: 'dboy_push_subs', col: 'dboy_name', conflict: 'dboy_name,endpoint', name: function () { return typeof dbLoggedInName !== 'undefined' ? dbLoggedInName : ''; } }
    : qs.get('manager') === '1'
      ? { table: 'manager_push_subs', col: 'manager_name', conflict: 'manager_name,endpoint', name: function () { return typeof mgrLoggedInName !== 'undefined' ? mgrLoggedInName : ''; } }
      : null;

  if (PN && cfg) {
    var fcmToken = null, savedFor = '', registering = false;
    var H = function (extra) {
      var h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
      for (var k in extra) h[k] = extra[k];
      return h;
    };

    function saveToken() {
      var name = cfg.name();
      if (!fcmToken || !name || savedFor === name) return;
      var row = { endpoint: 'fcm:' + fcmToken, subscription: { fcm: true, token: fcmToken }, updated_at: new Date().toISOString() };
      row[cfg.col] = name;
      fetch(SB_URL + '/rest/v1/' + cfg.table + '?on_conflict=' + cfg.conflict, {
        method: 'POST',
        headers: H({ Accept: 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(row)
      }).then(function (r) {
        if (r.ok) { savedFor = name; return; }
        r.text().then(function (t) { console.log('native-bridge: token save failed', r.status, t); });
      }).catch(function () {});
    }

    function removeToken(name) {
      if (!fcmToken || !name) return;
      // so a logged-out rider stops receiving other people's orders
      fetch(SB_URL + '/rest/v1/' + cfg.table + '?' + cfg.col + '=eq.' + encodeURIComponent(name) +
            '&endpoint=eq.' + encodeURIComponent('fcm:' + fcmToken), { method: 'DELETE', headers: H({}) }).catch(function () {});
    }

    async function setupPush() {
      if (registering) return;
      registering = true;
      try {
        // Loud, high-priority channel with the siren (file: android/app/src/main/res/raw/siren.wav)
        await PN.createChannel({ id: 'orders', name: 'New orders', description: 'New order alerts',
                                 importance: 5, visibility: 1, sound: 'siren.wav', vibration: true, lights: true });
        var perm = await PN.checkPermissions();
        if (perm.receive !== 'granted') perm = await PN.requestPermissions();
        if (perm.receive !== 'granted') {
          if (typeof showNotif === 'function') showNotif('🔕 Allow notifications in phone settings to get order alerts');
          registering = false; return;
        }
        await PN.register();
      } catch (e) { console.log('native-bridge: push setup failed', e); registering = false; }
    }

    PN.addListener('registration', function (t) { fcmToken = t.value; savedFor = ''; saveToken(); });
    PN.addListener('registrationError', function (e) { console.log('native-bridge: FCM registration error', e); registering = false; });

    var lastName = '';
    setInterval(function () {
      var name = cfg.name();
      if (name && !fcmToken) setupPush();
      if (name && fcmToken) saveToken();
      if (!name && lastName) { removeToken(lastName); savedFor = ''; registering = false; }
      lastName = name;
    }, 2000);
  }
})();
