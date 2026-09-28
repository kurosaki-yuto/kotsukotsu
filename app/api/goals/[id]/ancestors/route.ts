import { requireWorkspace, goalInScope } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { getAncestors } from "../../../../lib/server/queries";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const chain = await getAncestors(id, wctx.workspaceId); // [root ... self]
  if (!wctx.scopeGoalId) return json(chain);
  // never expose goals above the scope: drop everything before the scope goal.
  const at = chain.findIndex((g) => g.id === wctx.scopeGoalId);
  return json(at >= 0 ? chain.slice(at) : chain.slice(-1));
}
