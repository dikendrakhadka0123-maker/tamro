// Supabase Edge Function: send-promo-push
// Broadcasts a promotional push notification to every row in
// customer_push_subs. Triggered on-demand by the admin panel's
// "🚀 Send to All Customers" button — NOT by a database webhook (that
// pattern is for send-push-v3 / new orders only).
//
// IMPORTANT — this reuses the SAME VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT secrets that send-push-v3 already uses (Supabase Edge
// Function secrets are shared project-wide across all functions), so no
// new secrets should be needed. If send-push-v3 used different secret
// NAMES than the ones below, just rename these three lines to match.
//
// Optional hardening: set a PROMO_PUSH_SECRET env var on this function to
// require the client to send a matching 'x-promo-secret' header — if you
// don't set that secret, this check is simply skipped (works out of the box).

import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@tamro.app";

// These two are always auto-injected by Supabase for every Edge Function —
// no manual setup needed for them specifically.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const REQUIRED_SECRET = Deno.env.get("PROMO_PUSH_SECRET"); // optional, see note above

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req: Request) => {
  try {
    if (REQUIRED_SECRET && req.headers.get("x-promo-secret") !== REQUIRED_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    const { title, body, image, url } = await req.json();
    if (!title || !body) {
      return new Response(JSON.stringify({ error: "title and body are required" }), { status: 400 });
    }

    // Read every customer subscription using the service role key (server-
    // side only, never exposed to the browser) rather than the public anon key.
    const listRes = await fetch(
      `${SUPABASE_URL}/rest/v1/customer_push_subs?select=endpoint,subscription`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
    );
    if (!listRes.ok) {
      const errText = await listRes.text();
      return new Response(JSON.stringify({ error: "failed to read subscriptions", detail: errText }), { status: 500 });
    }
    const subs: { endpoint: string; subscription: any }[] = await listRes.json();

    const payload = JSON.stringify({
      type: "promo",
      title,
      body,
      image: image || undefined,
      url: url || "./",
    });

    let sent = 0;
    let removed = 0;
    let failed = 0;

    await Promise.all(
      subs.map(async (row) => {
        try {
          await webpush.sendNotification(row.subscription, payload);
          sent++;
        } catch (err: any) {
          // 404/410 = this subscription is dead (browser data cleared,
          // permission revoked, uninstalled, etc.) — clean it up so future
          // sends don't keep wasting time retrying it.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await fetch(
              `${SUPABASE_URL}/rest/v1/customer_push_subs?endpoint=eq.${encodeURIComponent(row.endpoint)}`,
              { method: "DELETE", headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
            );
            removed++;
          } else {
            failed++;
          }
        }
      })
    );

    return new Response(
      JSON.stringify({ total: subs.length, sent, removed, failed }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
