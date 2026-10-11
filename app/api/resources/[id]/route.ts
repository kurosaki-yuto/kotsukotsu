import { json, first } from "../../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../../lib/server/workspace";
import { deleteResource, canEditGoal } from "../../../lib/server/queries";
import { bucket } from "../../../lib/server/files";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const r = await first<{ goal_id: string | null; url: string | null }>("SELECT goal_id, url FROM resources WHERE id = ? AND workspace_id = ?", id, wctx.workspaceId);
  if (!r) return json({ error: "not found" }, { status: 404 });
  if (r.goal_id && !(await goalInScope(wctx.workspaceId, r.goal_id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (r.goal_id && !(await canEditGoal({ id: wctx.user.id, email: wctx.user.email, role: wctx.role }, r.goal_id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  // remove the backing R2 object for file resources — but only a key inside this
  // workspace/goal prefix (url は書き換えられるので、他所のキーを消させない)
  if (r.url && r.url.startsWith("r2:")) {
    const key = r.url.slice(3);
    if (r.goal_id && key.startsWith(`${wctx.workspaceId}/${r.goal_id}/`)) {
      try { await bucket()?.delete(key); } catch { /* tolerate */ }
    }
  }
  await deleteResource(id, wctx.workspaceId);
  return json({ ok: true });
}
