import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { all, run } from "./db";

type PushEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
function penv(): PushEnv {
  return getCloudflareContext().env as unknown as PushEnv;
}
export function vapidPublicKey(): string | null {
  return penv().VAPID_PUBLIC_KEY ?? null;
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Import the VAPID keypair (raw private scalar + uncompressed public point, both
// base64url) into a CryptoKey usable for ES256 (ECDSA P-256) signing.
async function importVapidKey(privB64: string, pubB64: string): Promise<CryptoKey> {
  const d = b64urlToBytes(privB64);
  const pub = b64urlToBytes(pubB64); // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256",
    d: bytesToB64url(d),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// Build the VAPID Authorization header (RFC 8292) for a push endpoint.
async function vapidAuth(endpoint: string): Promise<string | null> {
  const e = penv();
  if (!e.VAPID_PRIVATE_KEY || !e.VAPID_PUBLIC_KEY) return null;
  const aud = new URL(endpoint).origin;
  const enc = (o: unknown) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const body = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: e.VAPID_SUBJECT || "mailto:admin@kotsukotsu.app" });
  const input = `${head}.${body}`;
  const key = await importVapidKey(e.VAPID_PRIVATE_KEY, e.VAPID_PUBLIC_KEY);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `vapid t=${input}.${bytesToB64url(new Uint8Array(sig))}, k=${e.VAPID_PUBLIC_KEY}`;
}

// What a push shows on the lock screen. Without a payload the service worker
// falls back to fetching the latest unread notification — which turns into the
// generic 「新しい通知があります」 whenever the device's session cookie has
// expired. An encrypted payload always carries the real content.
export type PushPayload = { title: string; body?: string | null; url?: string | null };

type PushSub = { endpoint: string; p256dh: string | null; auth: string | null };

// RFC 8291 (aes128gcm) payload encryption against one subscription's keys.
// Returns null when the subscription has no keys — caller falls back to a
// no-payload push.
async function encryptPayload(sub: PushSub, plaintext: string): Promise<Uint8Array | null> {
  if (!sub.p256dh || !sub.auth) return null;
  const uaPub = b64urlToBytes(sub.p256dh); // 0x04 || X || Y (65 bytes)
  const authSecret = b64urlToBytes(sub.auth); // 16 bytes
  // ephemeral sender keypair (as)
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub as unknown as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const te = new TextEncoder();
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => {
    const key = await crypto.subtle.importKey("raw", ikm as unknown as ArrayBuffer, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info } as HkdfParams, key, len * 8));
  };
  // IKM = HKDF(auth_secret, ecdh, "WebPush: info" || 0x00 || ua_pub || as_pub, 32)
  const keyInfo = new Uint8Array([...te.encode("WebPush: info"), 0, ...uaPub, ...asPub]);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new Uint8Array([...te.encode("Content-Encoding: aes128gcm"), 0]), 16);
  const nonce = await hkdf(salt, ikm, new Uint8Array([...te.encode("Content-Encoding: nonce"), 0]), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  // single record: plaintext || 0x02 (last-record delimiter)
  const record = new Uint8Array([...te.encode(plaintext), 2]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // aes128gcm body header: salt(16) || rs(4) || idlen(1) || keyid(as_pub, 65)
  const header = new Uint8Array(16 + 4 + 1 + asPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  header.set(asPub, 21);
  const out = new Uint8Array(header.length + cipher.length);
  out.set(header, 0);
  out.set(cipher, header.length);
  return out;
}

// Fire one push. With a payload (and subscription keys) the content is
// encrypted per RFC 8291 so the lock screen shows the real title/body even
// when the device's app session is logged out. Falls back to a no-payload
// push (SW fetches the latest unread) when keys are missing or encryption
// fails. Returns the HTTP status (or 0 on network error).
async function sendOne(sub: PushSub, payload?: PushPayload | null): Promise<number> {
  const auth = await vapidAuth(sub.endpoint);
  if (!auth) { console.log(`[push] no vapid auth for ${sub.endpoint.slice(0, 60)}`); return 0; }
  let body: Uint8Array | null = null;
  if (payload) {
    try {
      body = await encryptPayload(sub, JSON.stringify(payload));
    } catch (e) {
      console.log(`[push] encrypt failed, falling back to no-payload: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    const r = body
      ? await fetch(sub.endpoint, {
          method: "POST",
          headers: { Authorization: auth, TTL: "86400", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Urgency: "high" },
          body: body as unknown as BodyInit,
        })
      : await fetch(sub.endpoint, { method: "POST", headers: { Authorization: auth, TTL: "86400", "Content-Length": "0" } });
    const bodyText = await r.text().catch(() => "");
    console.log(`[push] status=${r.status} payload=${body ? "aes128gcm" : "none"} endpoint=${sub.endpoint.slice(0, 60)} body=${bodyText.slice(0, 200)}`);
    return r.status;
  } catch (e) {
    console.log(`[push] fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

// Fire-and-forget a workspace push without blocking the response (uses the
// Worker's waitUntil so delivery continues after the response is sent).
export function queuePushToWorkspace(wsId: string, payload?: PushPayload | null): void {
  try {
    const ctx = (getCloudflareContext() as unknown as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } }).ctx;
    if (ctx?.waitUntil) {
      ctx.waitUntil(sendPushToWorkspace(wsId, payload));
      return;
    }
  } catch {
    /* no execution context available */
  }
  void sendPushToWorkspace(wsId, payload);
}

// Push to every device subscribed by any member of a workspace. Dead
// subscriptions (404/410) are pruned. Best-effort; never throws.
export async function sendPushToWorkspace(wsId: string, payload?: PushPayload | null): Promise<void> {
  try {
    const subs = await all<PushSub>(
      `SELECT ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
         JOIN workspace_members wm ON wm.user_id = ps.user_id
        WHERE wm.workspace_id = ?`,
      wsId
    );
    if (!subs.length) return;
    await Promise.all(
      subs.map(async (s) => {
        const status = await sendOne(s, payload);
        if (status === 404 || status === 410) {
          await run("DELETE FROM push_subscriptions WHERE endpoint = ?", s.endpoint).catch(() => {});
        }
      })
    );
  } catch {
    /* tolerate */
  }
}

// Fire-and-forget push scoped to specific members (by email) plus admins —
// used for goal-linked events so only the people connected to that goal get
// pinged, not the whole workspace.
export function queuePushToMembers(wsId: string, emails: string[], payload?: PushPayload | null): void {
  try {
    const ctx = (getCloudflareContext() as unknown as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } }).ctx;
    if (ctx?.waitUntil) {
      ctx.waitUntil(sendPushToMembers(wsId, emails, payload));
      return;
    }
  } catch {
    /* no execution context available */
  }
  void sendPushToMembers(wsId, emails, payload);
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// Push to exactly the given member emails. Admins used to be added to every
// single push here "for oversight" — that turned every event in the workspace
// into a phone buzz for them, and real @mentions drowned in it. A push now
// goes to the people the notification is actually for: the mentioned person,
// or the goal's assignees. Dead subscriptions (404/410) are pruned.
// Best-effort; never throws.
export async function sendPushToMembers(wsId: string, emails: string[], payload?: PushPayload | null): Promise<void> {
  try {
    const lower = [...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
    if (!lower.length) return;
    // Chunked: one bound parameter per email blows D1's per-query cap once a
    // notification fans out to a large workspace, and the failure mode is a
    // thrown query that silently sends nobody a push.
    const CHUNK = 50;
    const batches = chunk(lower, CHUNK);
    const seen = new Set<string>();
    const subs: PushSub[] = [];
    for (const batch of batches) {
      const rows = await all<PushSub>(
        `SELECT DISTINCT ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
           JOIN workspace_members wm ON wm.user_id = ps.user_id AND wm.workspace_id = ?
           JOIN users u ON u.id = ps.user_id
          WHERE lower(u.email) IN (${batch.map(() => "?").join(",")})`,
        wsId, ...batch
      );
      for (const r of rows) if (!seen.has(r.endpoint)) { seen.add(r.endpoint); subs.push(r); }
    }
    if (!subs.length) return;
    await Promise.all(
      subs.map(async (s) => {
        const status = await sendOne(s, payload);
        if (status === 404 || status === 410) {
          await run("DELETE FROM push_subscriptions WHERE endpoint = ?", s.endpoint).catch(() => {});
        }
      })
    );
  } catch {
    /* tolerate */
  }
}
