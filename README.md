# TAMRO — safe rollout (live app)

All of this was tested in a headless Chrome (Android user agent): all four roles load with zero JS errors, identical to your current
file; back-button logic, reload, offline cache and service-worker install pass. NOT tested: a real phone, the Play Store app, Supabase
functions, Firebase, the Capacitor Android app.

## STEP 1 — GitHub (repo root). 4 files, in THIS order:
  1. ADD      sw-shell.js
  2. ADD      native-bridge.js
  3. REPLACE  sw.js          (your file + 1 safe line at the top; if sw-shell.js is missing, push still works)
  4. REPLACE  index.html     (your latest file; the ONLY removed line is the APP_VERSION number, everything else is additions)
  Touch nothing else (assetlinks.json, manifest.json, icons, CNAME, send-promo-push, index.ts stay as they are).
  Roll back any time: GitHub -> the commit -> Revert. Customers/riders auto-reload onto the new build within a minute (APP_VERSION).

## What changes for users after step 1
  Everyone: nothing visible, except buttons can't be long-press-selected and the bottom tab bar respects the phone's gesture bar.
  Installed Android app, delivery boy + manager: Back button closes the open popup first, then asks "Press back again to exit".
  Customer app (Play Store): back-button logic is OFF. To turn on later, set ENABLE_FOR_CUSTOMER=true near the bottom of index.html.
  Install flow, manifests and install prompts are NOT changed for anyone (the customer app deliberately avoids the WebAPK install).

## STEP 2 — rotate your VAPID keys (your private key sits in DEPLOY-PUSH-NOTIFICATIONS.md in the repo)
  npx web-push generate-vapid-keys
  supabase secrets set VAPID_PUBLIC_KEY=<new public> VAPID_PRIVATE_KEY=<new private>
  index.html: replace the VAPID_PUBLIC_KEY value and change PUSH_SETUP_VERSION to 'v3-rotated' (phones silently re-subscribe)
  Then delete the key line from DEPLOY-PUSH-NOTIFICATIONS.md.
  Do the rotation as ONE quick change (secret + index.html together), otherwise alerts pause until phones re-subscribe.

## STEP 3 (only when you want it) — send-push-v4 in Supabase (files in supabase-deploy/functions/)
  supabase secrets set FCM_CALL_SECRET="<long random string>"
  supabase functions deploy send-push-v4 --no-verify-jwt
  Dashboard -> Database -> Webhooks: create one for table orders, Insert only, function send-push-v4, header x-tamro-secret = that string.
  SAFE SWITCH: turn the old send-push-v3 webhook OFF, place one test order, check a rider's phone buzzes + read the function logs.
  If anything is wrong: turn v4's webhook OFF and v3's back ON (30 seconds). Never leave both ON (double alerts).
  Behaviour differences vs v3: riders of other branches are not alerted; only the dead device is deleted; branch manager is alerted too.

## STEP 4 (later, optional) — Android delivery app with siren + background location: see android-app/capacitor-delivery
  Needs Firebase + Android Studio. Do not start this until steps 1-3 are stable. Also deploy send-fcm-push + set FCM_SERVICE_ACCOUNT then.

## optional-later/  (NOT needed now): manifest-*.json + icons. Skip them: your current install setup works and the customer
  version would have re-enabled the Android install prompt you removed on purpose.
