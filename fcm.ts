// FCM HTTP v1 sender for Supabase Edge Functions (Deno). No external dependencies.
// Needs the secret FCM_SERVICE_ACCOUNT = the full service-account JSON from Firebase
// (Project settings -> Service accounts -> Generate new private key).

const enc = new TextEncoder();
const SA = JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT") ?? "{}");

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

let cached: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  if (!SA.client_email || !SA.private_key) throw new Error("FCM_SERVICE_ACCOUNT secret is missing or invalid");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const key = await importKey(SA.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned)));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("FCM auth failed: " + JSON.stringify(j));
  cached = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return cached.token;
}

export type FcmResult = { ok: boolean; unregistered: boolean; status: number; error?: string };

export async function sendFcm(
  deviceToken: string,
  msg: { title: string; body: string; data?: Record<string, unknown>; channelId?: string },
): Promise<FcmResult> {
  const access = await getAccessToken();
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.data ?? {})) data[k] = String(v); // FCM data values must be strings

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${SA.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: msg.title, body: msg.body },
        data,
        android: {
          priority: "HIGH",          // wakes the phone even in Doze
          ttl: "120s",               // an order alert older than 2 minutes is useless
          notification: { channel_id: msg.channelId ?? "orders", sound: "siren" },
        },
      },
    }),
  });
  if (res.ok) return { ok: true, unregistered: false, status: res.status };
  const text = await res.text();
  // token belongs to an uninstalled / reset app -> caller should delete the row
  const unregistered = res.status === 404 || text.includes("UNREGISTERED") || text.includes("INVALID_ARGUMENT") && text.includes("registration token");
  return { ok: false, unregistered, status: res.status, error: text.slice(0, 300) };
}
