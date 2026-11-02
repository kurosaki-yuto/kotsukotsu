import { json } from "../../../../lib/server/db";
import { requireWorkspace, goalVisible, trimAncestors } from "../../../../lib/server/workspace";
import { goalBundle } from "../../../../lib/server/queries";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalVisible(wctx, id))) return json({ error: "not found" }, { status: 404 });
  const b = await goalBundle(id, wctx.workspaceId);
  if (!b) return json({ error: "not found" }, { status: 404 });
  // パンくず: 見える範囲より上の親は名前も返さない
  b.ancestors = await trimAncestors(wctx, b.ancestors);
  return json(b);
}
