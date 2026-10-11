import { json, bad } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { limitOr429, MIN } from "../../lib/server/ratelimit";

const NOTIFICATION_KINDS = new Set(["info", "mention", "goal"]);
import { listNotifications, unreadCount, createNotification, markAllRead, markNotificationsSeen, getGoal } from "../../lib/server/queries";

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
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) return bad("title required", 400);
  const kind = body.kind && NOTIFICATION_KINDS.has(body.kind) ? body.kind : "info";
  const text = typeof body.body === "string" ? body.body.slice(0, 2000) : null;
  const goalId = typeof body.goal_id === "string" && body.goal_id ? body.goal_id : null;
  if (goalId) {
    // 自分のワークスペース・スコープの中のゴールにしか出せない (goalInScope はスコープ無しだと存在を見ないので、先に引く)
    if (!(await getGoal(goalId, ctx.workspaceId))) return json({ error: "not found" }, { status: 404 });
    if (!(await goalInScope(ctx.workspaceId, goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  } else if (ctx.role !== "admin") {
    // ゴール無し = 全員のスマホに届く。管理者だけ
    return json({ error: "forbidden" }, { status: 403 });
  }
  const limited = await limitOr429(`notify:user:${ctx.user.id}`, 30, 15 * MIN);
  if (limited) return limited;
  try {
    await createNotification({ kind, title, body: text, goal_id: goalId }, ctx.workspaceId);
  } catch {
    return json({ error: "not found" }, { status: 404 });
  }
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
