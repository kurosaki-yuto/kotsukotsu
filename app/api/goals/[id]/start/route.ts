import { requireWorkspace, goalInScope } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { setProjectStarted, canEditGoal } from "../../../../lib/server/queries";

// 「開始」ボタン。押した人を開始した人として残す (via = app)。
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await canEditGoal({ id: wctx.user.id, email: wctx.user.email, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { started?: boolean };
  await setProjectStarted(id, body.started !== false, wctx.workspaceId, {
    userId: wctx.user.id,
    name: wctx.user.name || wctx.user.email,
    via: "app",
  });
  return json({ ok: true });
}
