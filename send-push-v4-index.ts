// TAMRO — send-push Edge Function  (DEPLOYED AS send-push-v4, version 5)
// Triggered by a Supabase Database Webhook on INSERT into `orders`.
// Webhook header expected:  x-webhook-secret = <WEBHOOK_SECRET secret>
// Sends a real Web Push notification to:
//  1) every active delivery boy OF THIS ORDER'S BRANCH who has enabled alerts
//  2) every active branch manager assigned to this specific order's branch
// so their phones buzz/ring even if the app is closed.
//
// urgency:'high' on every send below tells the push service (FCM, on
// Android) to attempt immediate delivery and bypass Doze-mode deferral —
// the same mechanism native delivery-driver apps rely on for reliable
// background alerts.
//
// TTL is 15 minutes: long enough that a phone that is briefly asleep/offline
// still gets the alert when it wakes (the old 5 min dropped alerts), short
// enough that a stale "new order" is not delivered hours later.
// Each push carries a UNIQUE tag per order so a second order never silently
// replaces the first notification (iPhone does not re-alert on a replaced tag).

// deno-lint-ignore-file no-explicit-any
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Shared send options for every order-alert push in this function.
const PUSH_OPTS = { urgency: "high" as const, TTL: 900 };

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

// Branch rule — identical to the delivery app's own order list: a rider is alerted only for orders of THEIR branch.
// A rider with no branch set, or an order with no branch recorded, counts as "any" (same as the app), so nothing is lost.
function riderServesBranch(d: any, orderLocationId: string | null): boolean {
  if (!orderLocationId || !d.locationId) return true;
  return d.locationId === orderLocationId;
}

async function getActiveDboySubs(menuData: any, locationId: string | null): Promise<any[]> {
  const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/dboy_push_subs?select=dboy_name,subscription,endpoint`, {
    headers: sbHeaders(),
  }).then((r) => r.json());
  const dboys = Array.isArray(menuData?.dboys) ? menuData.dboys : [];
  const activeNames = new Set(
    dboys
      .filter((d: any) => d.status !== "leave" && riderServesBranch(d, locationId))
      .map((d: any) => String(d.name).trim().toLowerCase())
  );
  return (Array.isArray(subsRes) ? subsRes : []).filter((s: any) =>
    activeNames.has(String(s.dboy_name).trim().toLowerCase())
  );
}

// Managers scoped to ONE specific branch — only active managers whose
// assigned branch matches this order's location_id get notified, so a
// manager never hears about orders from a branch that isn't theirs.
async function getActiveManagerSubsForBranch(menuData: any, locationId: string | null): Promise<any[]> {
  if (!locationId) return [];
  const subsRes = await fetch(`${SUPABASE_URL}/rest/v1/manager_push_subs?select=manager_name,subscription,endpoint`, {
    headers: sbHeaders(),
  }).then((r) => r.json());
  const managers = Array.isArray(menuData?.managers) ? menuData.managers : [];
  const activeNamesForBranch = new Set(
    managers
      .filter((m: any) => m.status !== "leave" && m.locationId === locationId)
      .map((m: any) => String(m.name).trim().toLowerCase())
  );
  return (Array.isArray(subsRes) ? subsRes : []).filter((s: any) =>
    activeNamesForBranch.has(String(s.manager_name).trim().toLowerCase())
  );
}

async function deleteDboySub(endpoint: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/dboy_push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { method: "DELETE", headers: sbHeaders() }
  );
}
async function deleteManagerSub(endpoint: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/manager_push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { method: "DELETE", headers: sbHeaders() }
  );
}

// Sends to a batch of subs, reports results, and cleans up any dead
// (404/410) subscriptions. Shared by both the dboy send and the manager
// send so the two stay in sync and behave identically.
async function sendAndCleanup(
  subs: any[],
  notifPayload: string,
  nameField: "dboy_name" | "manager_name",
  deleteFn: (endpoint: string) => Promise<void>
) {
  const results = await Promise.allSettled(
    subs.map((s: any) => webpush.sendNotification(s.subscription, notifPayload, PUSH_OPTS))
  );
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const reason: any = r.reason;
      const detail = `${nameField}=${subs[i]?.[nameField]} statusCode=${reason?.statusCode} body=${reason?.body} message=${reason?.message || reason}`;
      console.error("push send failed:", detail);
      errors.push(detail);
    }
  });
  await Promise.all(
    results.map((r, i) => {
      if (r.status === "rejected") {
        const statusCode = (r.reason as any)?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          return deleteFn(subs[i].endpoint);
        }
      }
      return Promise.resolve();
    })
  );
  return { sent: results.filter((r) => r.status === "fulfilled").length, total: subs.length, errors };
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

    // ── DEBUG MODE — reports exactly what's actually stored, no guessing ──
    // Call with body: {"debug":true}
    if (payload?.debug) {
      function mask(s: string) {
        if (!s) return { present: false };
        return {
          present: true,
          length: s.length,
          first4: s.slice(0, 4),
          last4: s.slice(-4),
          hasEquals: s.includes("="),
          hasPlus: s.includes("+"),
          hasSlash: s.includes("/"),
          hasWhitespace: /\s/.test(s),
        };
      }
      return new Response(
        JSON.stringify({
          VAPID_PUBLIC_KEY: mask(VAPID_PUBLIC_KEY),
          VAPID_PRIVATE_KEY: mask(VAPID_PRIVATE_KEY),
          VAPID_SUBJECT,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const record = payload?.record;
    if (!record) {
      return new Response(JSON.stringify({ skipped: "no record" }), { status: 200 });
    }

    if (record.accepted_by) {
      return new Response(JSON.stringify({ skipped: "already accepted" }), { status: 200 });
    }

    const menuData = await getMenuData();
    const custName = record.customer_name || "a customer";
    // Unique per order, so each new order gets its own notification.
    const orderTag = "order-" + String(record.id ?? Date.now());

    // ── Delivery boys — only active riders of this order's branch ──
    const dboySubs = await getActiveDboySubs(menuData, record.location_id ?? null);
    const dboyPayload = JSON.stringify({
      title: "🔔 New Order — TAMRO",
      body: `New order from ${custName} — tap to view`,
      url: "./?dboy=1",
      tag: orderTag,
    });
    const dboyResult = await sendAndCleanup(dboySubs, dboyPayload, "dboy_name", deleteDboySub);

    // ── Branch managers — only the ones assigned to this order's branch ──
    const managerSubs = await getActiveManagerSubsForBranch(menuData, record.location_id ?? null);
    const branchName = record.location_name || "your branch";
    const managerPayload = JSON.stringify({
      title: "🔔 New Order — " + branchName,
      body: `New order from ${custName} — tap to view`,
      url: "./?manager=1",
      tag: orderTag,
    });
    const managerResult = managerSubs.length
      ? await sendAndCleanup(managerSubs, managerPayload, "manager_name", deleteManagerSub)
      : { sent: 0, total: 0, errors: [] as string[] };

    return new Response(
      JSON.stringify({ dboys: dboyResult, managers: managerResult }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("send-push error", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
