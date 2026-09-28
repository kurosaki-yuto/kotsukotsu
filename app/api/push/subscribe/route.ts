import { json, run } from "../../../lib/server/db";
import { requireUser } from "../../../lib/server/auth";

// Store (or refresh) a Web Push subscription for the current user.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!body.endpoint) return json({ error: "endpoint required" }, { status: 400 });
  await run(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    body.endpoint, user.id, body.keys?.p256dh ?? null, body.keys?.auth ?? null
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
