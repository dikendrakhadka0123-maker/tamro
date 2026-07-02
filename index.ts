// TAMRO — send-push Edge Function
// Triggered by a Supabase Database Webhook on INSERT into `orders`.
// Sends a real Web Push notification to every active delivery boy who has
// enabled alerts, so their phone buzzes/rings even if the app is closed.

// deno-lint-ignore-file no-explicit-any
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET"); // optional but recommended

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function sbHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function getMenuData(): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/menu?id=eq.tamro&select=data`, {
    headers: sbHeaders(),
  });
  const json = await res.json();
  return (Array.isArray(json) && json[0] && json[0].data) || {};
}

async function getActiveDboySubs(): Promise<any[]> {
  const [subsRes, menuData] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/dboy_push_subs?select=dboy_name,subscription`, {
      headers: sbHeaders(),
    }).then((r) => r.json()),
    getMenuData(),
  ]);
  // dboys are stored inside menu.data.dboys (this app has no separate dboys table)
  const dboys = Array.isArray(menuData?.dboys) ? menuData.dboys : [];
  const activeNames = new Set(
    dboys
      .filter((d: any) => d.status !== "leave")
      .map((d: any) => String(d.name).trim().toLowerCase())
  );
  return (Array.isArray(subsRes) ? subsRes : []).filter((s: any) =>
    activeNames.has(String(s.dboy_name).trim().toLowerCase())
  );
}

async function deleteSub(dboyName: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/dboy_push_subs?dboy_name=eq.${encodeURIComponent(dboyName)}`,
    { method: "DELETE", headers: sbHeaders() }
  );
}

Deno.serve(async (req) => {
  try {
    if (WEBHOOK_SECRET) {
      const provided = req.headers.get("x-webhook-secret");
      if (provided !== WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const payload = await req.json();
    const record = payload?.record;
    if (!record) {
      return new Response(JSON.stringify({ skipped: "no record" }), { status: 200 });
    }

    // Only alert for brand-new, unclaimed orders (visible to every dboy).
    // Avoids double-pinging everyone when an order is later updated/accepted.
    if (record.accepted_by) {
      return new Response(JSON.stringify({ skipped: "already accepted" }), { status: 200 });
    }

    const subs = await getActiveDboySubs();
    const custName = record.customer_name || "a customer";

    const notifPayload = JSON.stringify({
      title: "🔔 New Order — TAMRO",
      body: `New order from ${custName} — tap to view`,
      url: "./?dboy=1",
    });

    const results = await Promise.allSettled(
      subs.map((s: any) => webpush.sendNotification(s.subscription, notifPayload))
    );

    // Clean up subscriptions that are no longer valid (expired/unsubscribed)
    await Promise.all(
      results.map((r, i) => {
        if (r.status === "rejected") {
          const statusCode = (r.reason as any)?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            return deleteSub(subs[i].dboy_name);
          }
        }
        return Promise.resolve();
      })
    );

    return new Response(
      JSON.stringify({ sent: results.filter((r) => r.status === "fulfilled").length, total: subs.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("send-push error", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
