import { json, bad } from "../../lib/server/db";
import { requireWorkspace } from "../../lib/server/workspace";
import { listNotifications, unreadCount, createNotification, markAllRead, markNotificationsSeen } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  // admins see everything (full oversight); everyone else only sees
  // notifications for goals they're actually connected to (see
  // memberRelevantGoalIds) plus goal-less/org-level ones. Read state is
  // always per-viewer.
  const viewer = { email: ctx.user.email, admin: ctx.role === "admin" };
  const sp = new URL(req.url).searchParams;
  if (sp.get("count")) return json({ count: await unreadCount(ctx.workspaceId, viewer) });
  const filter = sp.get("filter") === "unread" ? "unread" : "all";
  const offset = Math.max(0, Number.parseInt(sp.get("offset") ?? "0", 10) || 0);
  return json(await listNotifications(filter, ctx.workspaceId, viewer, offset));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    title?: string;
    body?: string | null;
    goal_id?: string | null;
  };
  if (!body.title) return bad("title required", 400);
  await createNotification({ kind: body.kind, title: body.title, body: body.body ?? null, goal_id: body.goal_id ?? null }, ctx.workspaceId);
  return json({ ok: true });
}

export async function PATCH(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { all?: boolean; seen?: boolean };
  // seen = ベルのバッジだけ落とす (通知ページを開いた合図)。既読にはしない。
  if (body.seen) await markNotificationsSeen(ctx.workspaceId, ctx.user.email);
  if (body.all) {
    await markAllRead(ctx.workspaceId, { email: ctx.user.email, admin: ctx.role === "admin" });
    await markNotificationsSeen(ctx.workspaceId, ctx.user.email);
  }
  return json({ ok: true });
}
