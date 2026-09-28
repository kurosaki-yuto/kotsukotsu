import { requireWorkspace, goalInScope } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { toggleProjectDone, canEditGoal, assignOnTouch } from "../../../../lib/server/queries";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await canEditGoal({ id: wctx.user.id, email: wctx.user.email, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { done?: boolean };
  await toggleProjectDone(id, !!body.done, wctx.workspaceId);
  return json({ ok: true });
}
