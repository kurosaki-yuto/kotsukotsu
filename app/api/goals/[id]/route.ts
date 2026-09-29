import { json } from "../../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../../lib/server/workspace";
import { getGoal, updateGoal, archiveGoal, canEditGoal, assignOnTouch } from "../../../lib/server/queries";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const goal = await getGoal(id, wctx.workspaceId);
  if (!goal) return json({ error: "not found" }, { status: 404 });
  return json(goal);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (!(await canEditGoal({ id: wctx.user.id, email: wctx.user.email, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  await updateGoal(id, patch, wctx.workspaceId);
  await assignOnTouch(wctx.user, id, wctx.workspaceId);
  return json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (!(await canEditGoal({ id: wctx.user.id, email: wctx.user.email, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  await archiveGoal(id, wctx.workspaceId);
  return json({ ok: true });
}
