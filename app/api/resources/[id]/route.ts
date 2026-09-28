import { json, first } from "../../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../../lib/server/workspace";
import { deleteResource } from "../../../lib/server/queries";
import { bucket } from "../../../lib/server/files";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const r = await first<{ goal_id: string | null; url: string | null }>("SELECT goal_id, url FROM resources WHERE id = ? AND workspace_id = ?", id, wctx.workspaceId);
  if (r?.goal_id && !(await goalInScope(wctx.workspaceId, r.goal_id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  // remove the backing R2 object for file resources
  if (r?.url && r.url.startsWith("r2:")) {
    try { await bucket()?.delete(r.url.slice(3)); } catch { /* tolerate */ }
  }
  await deleteResource(id, wctx.workspaceId);
  return json({ ok: true });
}
