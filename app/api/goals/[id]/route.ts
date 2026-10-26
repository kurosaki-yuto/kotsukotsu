import { json } from "../../../lib/server/db";
import { requireWorkspace, goalInScope, requireGoalEdit } from "../../../lib/server/workspace";
import { getGoal, updateGoal, archiveGoal, assignOnTouch, GoalTextTooLong } from "../../../lib/server/queries";

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
  const denied = await requireGoalEdit(wctx, id); if (denied) return denied;
  const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    await updateGoal(id, patch, wctx.workspaceId);
  } catch (e) {
    if (e instanceof GoalTextTooLong) return json({ error: e.message, field: e.field }, { status: 400 });
    throw e;
  }
  await assignOnTouch(wctx.user, id, wctx.workspaceId);
  return json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const denied = await requireGoalEdit(wctx, id); if (denied) return denied;
  await archiveGoal(id, wctx.workspaceId);
  return json({ ok: true });
}
