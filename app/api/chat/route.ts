import { limitOr429, MIN } from "../../lib/server/ratelimit";
import { json, bad } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { listMessages, messageCount, sendMessage, getMyProfile } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const goal = sp.get("goal");
  if (!goal) return bad("goal required", 400);
  if (!(await goalInScope(ctx.workspaceId, goal, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (sp.get("count")) return json({ count: await messageCount(goal, ctx.workspaceId) });
  return json(await listMessages(goal, ctx.workspaceId));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    goalId?: string;
    body?: string;
    role?: string;
  };
  if (!body.goalId || !body.body) return bad("goalId and body required", 400);
  if (!(await goalInScope(ctx.workspaceId, body.goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  // author is always resolved from the authenticated session, never trusted
  // from the client — otherwise anyone can post as anyone (this is exactly
  // why every comment used to show up as "黒崎優斗" regardless of who wrote it).
  // 画面からの投稿は常に本人 (user)。role を送って AI やシステムを名乗れないようにする
  const role = "user";
  const text = String(body.body).slice(0, 20000);
  const limited = await limitOr429(`chat:user:${ctx.user.id}`, 120, 15 * MIN);
  if (limited) return limited;
  const author = (await getMyProfile(ctx.user, ctx.workspaceId)).name || ctx.user.name || ctx.user.email;
  return json(await sendMessage(body.goalId, text, ctx.workspaceId, role, author, ctx.user.email));
}
