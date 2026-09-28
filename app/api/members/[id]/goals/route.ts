import { requireWorkspace } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { listMemberGoals } from "../../../../lib/server/queries";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const rows = (await listMemberGoals(id, wctx.workspaceId)) as Array<Record<string, unknown>>;
  return json(rows.map((r) => ({ ...r, can_edit: !!r.can_edit })));
}
