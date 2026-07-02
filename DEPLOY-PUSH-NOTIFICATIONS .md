# TAMRO — Enabling real "app closed / phone locked" order alerts

This makes the delivery boy app buzz + ring + show a notification even when
the phone is locked or the app isn't open — the same mechanism every
notification-capable website uses (Web Push). It needs three things, all
already written for you:

1. `sw.js` — the service worker (already wired into `index.html`)
2. `supabase-setup.sql` — one new database table
3. `supabase/functions/send-push/index.ts` — the server piece that actually
   sends the push the moment a new order comes in

You'll deploy #2 and #3 yourself since I don't have access to your Supabase
project. It's about 15 minutes, one time only.

---

## 0. Files — where they go

- `sw.js` → upload to the **same folder as `index.html`** on your web host
  (it must be reachable at `yoursite.com/sw.js`, or `yoursite.com/subfolder/sw.js`
  if TAMRO lives in a subfolder — same folder either way).
- `supabase-setup.sql` and `supabase/functions/send-push/index.ts` → used in
  the steps below, don't need to be publicly hosted.

## 1. Run the SQL

Supabase Dashboard → **SQL Editor** → paste the contents of
`supabase-setup.sql` → **Run**.

## 2. Install the Supabase CLI (if you don't have it)

```bash
npm install -g supabase
supabase login
```

## 3. Link your project

```bash
supabase link --project-ref eqvdtomtgxwgdtnniuzv
```
(That ref is read from your app's existing `SB_URL`.)

## 4. Set the function secrets

```bash
supabase secrets set VAPID_PUBLIC_KEY=BNR2xUv6vrguLpfC7PMSFacks2F3TN-wfGHv2J-3ikn_pNgntU-YNXmlqS5jNE2-2Am9g-UzEfMFsu3pjf6E1Po
supabase secrets set VAPID_PRIVATE_KEY=WlnUx9h-kF1AsaKmW3a_8-mquv0CCR-4wdzptWVwSLg
supabase secrets set VAPID_SUBJECT=mailto:you@example.com
supabase secrets set WEBHOOK_SECRET=choose-a-random-long-string-here
```

⚠️ `VAPID_PRIVATE_KEY` is a secret — never put it in `index.html` or anywhere
public. Only `VAPID_PUBLIC_KEY` (already in the app code) is safe to expose.

`WEBHOOK_SECRET` — make up any long random string. You'll reuse it in step 6.
This stops random people from calling your function and spamming pushes.

## 5. Deploy the function

```bash
supabase functions deploy send-push --no-verify-jwt
```

`--no-verify-jwt` is needed because the Database Webhook won't send a
Supabase user JWT — that's exactly why we check `WEBHOOK_SECRET` ourselves
inside the function instead.

## 6. Wire it to new orders (Database Webhook)

Supabase Dashboard → **Database** → **Webhooks** → **Create a new webhook**

- Name: `notify-dboys-new-order`
- Table: `orders`
- Events: ✅ Insert only
- Type: **Supabase Edge Functions**
- Edge Function: `send-push`
- HTTP Headers → add: `x-webhook-secret` = *(the same random string from step 4)*

Save.

## 7. Turn it on in the app

Open the delivery boy app (`?dboy=1`), log in — you'll see a new **"🔔 Enable
Order Alerts"** banner. Tap it once, allow notifications when the browser
asks. That's it for that driver; each driver does this once on their own
phone.

## Notes & limits

- **Android**: works great in Chrome and in the installed/home-screen app.
- **iPhone**: only works if the app was **added to the Home Screen** first
  (Share → Add to Home Screen) and is opened from that icon — Safari tabs
  can't receive push on iOS. Also needs iOS 16.4+.
- If a driver uninstalls/reinstalls or clears site data, they'll need to tap
  "Enable Order Alerts" again — the function auto-removes dead subscriptions
  when it detects them.
- The foreground alert (sound/vibration/popup while the app is open) still
  works exactly as before and needs none of this setup — this is purely for
  the "app closed" case.
