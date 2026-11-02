import { requireWorkspace, goalVisible, trimAncestors } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { getAncestors } from "../../../../lib/server/queries";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalVisible(wctx, id))) return json({ error: "not found" }, { status: 404 });
  const chain = await getAncestors(id, wctx.workspaceId); // [root ... self]
  // 見える範囲より上のゴールは出さない (名前もリンクも)。
  return json(await trimAncestors(wctx, chain));
}
