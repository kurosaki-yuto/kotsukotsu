import { json, run } from "../../../lib/server/db";
import { requireUser } from "../../../lib/server/auth";
import { limitOr429, HOUR } from "../../../lib/server/ratelimit";

// プッシュ配信先として受け付けるホスト。ここ以外 (社内アドレスなど) を登録されると、配信時に
// サーバーからそこへ POST してしまう (Docker 版では内部ネットワークへの SSRF)。
function pushEndpointAllowed(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return (
    h === "fcm.googleapis.com" || h.endsWith(".googleapis.com") ||
    h.endsWith(".push.apple.com") ||
    h === "updates.push.services.mozilla.com" || h.endsWith(".push.services.mozilla.com") ||
    h.endsWith(".notify.windows.com")
  );
}

// Store (or refresh) a Web Push subscription for the current user.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!body.endpoint || typeof body.endpoint !== "string" || body.endpoint.length > 2000) return json({ error: "endpoint required" }, { status: 400 });
  if (!pushEndpointAllowed(body.endpoint)) return json({ error: "この配信先は受け付けられません" }, { status: 400 });
  const limited = await limitOr429(`push:user:${user.id}`, 30, HOUR);
  if (limited) return limited;
  // 同じ endpoint を別の人が上書きできない (他人の購読を奪って通知を横取りさせない)
  await run(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
       WHERE push_subscriptions.user_id = excluded.user_id`,
    body.endpoint, user.id, String(body.keys?.p256dh ?? "").slice(0, 300) || null, String(body.keys?.auth ?? "").slice(0, 100) || null
  );
  return json({ ok: true });
}

// Remove a subscription (on unsubscribe / logout).
export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (!user) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (!body.endpoint) return json({ error: "endpoint required" }, { status: 400 });
  await run("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", body.endpoint, user.id);
  return json({ ok: true });
}
