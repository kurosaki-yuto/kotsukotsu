import { requireWorkspace, goalInScope } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { moveGoal, canEditGoal } from "../../../../lib/server/queries";

// Re-parent a goal: body { parentId: string | null }. null = move to top level.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (!(await canEditGoal({ id: wctx.user.id, email: wctx.user.email, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { parentId?: string | null; beforeId?: string | null };
  const parentId = body.parentId ?? null;
  const beforeId = body.beforeId ?? null;
  // a scoped member can only move within their subtree
  if (parentId && !(await goalInScope(wctx.workspaceId, parentId, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const ok = await moveGoal(id, parentId, beforeId, wctx.workspaceId);
  return ok ? json({ ok: true }) : json({ error: "invalid move" }, { status: 400 });
}
