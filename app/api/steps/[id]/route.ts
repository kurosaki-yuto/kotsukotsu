import { requireWorkspace, goalInScope } from "../../../lib/server/workspace";
import { json, first } from "../../../lib/server/db";
import { setStepDone, canEditGoal } from "../../../lib/server/queries";

// 作業の手順のチェックを付け外しする (タスク詳細の「作業の手順」)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const s = await first<{ task_id: string }>("SELECT task_id FROM task_steps WHERE id = ? AND workspace_id = ?", id, wctx.workspaceId);
  if (!s || !(await goalInScope(wctx.workspaceId, s.task_id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (!(await canEditGoal({ id: wctx.user.id, email: wctx.user.email, role: wctx.role }, s.task_id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { done?: boolean };
  await setStepDone(id, !!body.done, wctx.workspaceId);
  return json({ ok: true });
}
