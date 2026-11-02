import { requireWorkspace, goalVisible } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { templateForGoal, templateViewer } from "../../../../lib/server/queries";

// このゴールの型 (ゴールか祖先が型から作られていれば)。ゴール画面の「この仕事の型」に出す
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalVisible(wctx, id))) return json({ error: "not found" }, { status: 404 });
  return json({ template: await templateForGoal(id, wctx.workspaceId, templateViewer(wctx)) });
}
