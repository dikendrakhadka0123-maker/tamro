// send-push-v4 — new-order alerts for riders (and the branch manager), Web Push + FCM in one function.
//
// Trigger: Supabase Dashboard -> Database -> Webhooks -> Create
//   Table: orders   Events: Insert   Type: Supabase Edge Function -> send-push-v4
//   HTTP header:  x-tamro-secret = <same value as the FCM_CALL_SECRET secret>
//   (Turn the old send-push-v3 webhook OFF, otherwise riders get every alert twice.)
//
// Deploy:  supabase functions deploy send-push-v4 --no-verify-jwt
// Secrets: FCM_SERVICE_ACCOUNT, FCM_CALL_SECRET (see README) and the VAPID secrets you already use for v3:
//          VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com)
//
// Differences from your send-push-v3 (index.ts):
//   + also sends FCM to the Android app (rows whose endpoint starts with "fcm:")
//   + only alerts riders of the order's branch (v3 alerted every active rider; riders of other branches
//     never see that order in dbFetchOrders anyway). Riders with no branch set still get everything.
//   + deletes only the ONE dead device (by endpoint). v3 deleted by dboy_name, which wiped a rider's
//     other, still-working phones whenever one subscription expired.
//   + also alerts the branch manager (v3 did not).
import webpush from "npm:web-push@3.6.7";
import { sendFcm } from "../_shared/fcm.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("FCM_CALL_SECRET");

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@tamro.com.np",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

type Person = { name: string; locationId?: string; status?: string };
type SubRow = { endpoint: string; subscription: any } & Record<string, any>;

function sameBranch(p: Person, orderLoc?: string | null) {
  return !orderLoc || !p.locationId || p.locationId === orderLoc;
}

async function deliver(table: string, nameCol: string, names: Set<string>, msg: { title: string; body: string; url: string; data: Record<string, unknown> }) {
  if (!names.size) return { devices: 0, sent: 0, removed: 0 };
  const rows: SubRow[] = await (await rest(`${table}?select=endpoint,subscription,${nameCol}`)).json();
  const mine = rows.filter((r) => names.has(String(r[nameCol] ?? "").trim().toLowerCase()));
  let sent = 0, removed = 0;
  await Promise.all(mine.map(async (r) => {
    let dead = false;
    try {
      if (r.subscription?.fcm || r.endpoint.startsWith("fcm:")) {
        const res = await sendFcm(r.subscription?.token ?? r.endpoint.slice(4), { title: msg.title, body: msg.body, data: msg.data });
        if (res.ok) sent++; else { console.log("FCM fail", res.status, res.error); dead = res.unregistered; }
      } else {
        await webpush.sendNotification(
          r.subscription,
          JSON.stringify({ title: msg.title, body: msg.body, url: msg.url }),
          { TTL: 120, urgency: "high" },
        );
        sent++;
      }
    } catch (e: any) {
      console.log("push fail", e?.statusCode, String(e?.body ?? e).slice(0, 200));
      dead = e?.statusCode === 404 || e?.statusCode === 410; // browser subscription expired/unsubscribed
    }
    if (dead) { removed++; await rest(`${table}?endpoint=eq.${encodeURIComponent(r.endpoint)}`, { method: "DELETE" }); }
  }));
  return { devices: mine.length, sent, removed };
}

Deno.serve(async (req) => {
  if (!SECRET || req.headers.get("x-tamro-secret") !== SECRET) return new Response("forbidden", { status: 403 });
  try {
    const payload = await req.json();
    const o = payload.record ?? payload;               // DB webhook sends { type, table, record, ... }
    if (payload.type && payload.type !== "INSERT") return Response.json({ skipped: "not an insert" });
    // same rule as v3: only brand-new, unclaimed orders
    if (o.accepted_by) return Response.json({ skipped: "already accepted" });

    // Only the two arrays we need from the big menu row
    const m = await (await rest("menu?id=eq.tamro&select=dboys:data->dboys,managers:data->managers")).json();
    const dboys: Person[] = m?.[0]?.dboys ?? [];
    const managers: Person[] = m?.[0]?.managers ?? [];

    const riderNames = new Set(
      dboys.filter((d) => (d.status ?? "active") === "active" && sameBranch(d, o.location_id)).map((d) => d.name.trim().toLowerCase()),
    );
    const managerNames = new Set(
      managers.filter((g) => o.location_id && g.locationId === o.location_id).map((g) => g.name.trim().toLowerCase()),
    );

    const custName = o.customer_name || "a customer";
    const body = `New order from ${custName} — tap to view`;   // same wording as v3
    const data = { orderId: o.id ?? "" };

    const [riders, mgrs] = await Promise.all([
      deliver("dboy_push_subs", "dboy_name", riderNames, { title: "🔔 New Order — TAMRO", body, url: "./?dboy=1", data }),
      deliver("manager_push_subs", "manager_name", managerNames, { title: "🔔 New Order — TAMRO", body, url: "./?manager=1", data }),
    ]);
    return Response.json({ riders, managers: mgrs });
  } catch (e) {
    console.log("send-push-v4 error", e);
    return new Response(String(e), { status: 500 });
  }
});
