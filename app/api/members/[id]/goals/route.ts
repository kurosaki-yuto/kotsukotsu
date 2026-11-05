import { requireWorkspace, viewRoots } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { listMemberGoals, listGoals } from "../../../../lib/server/queries";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  let rows = (await listMemberGoals(id, wctx.workspaceId, wctx.scopeGoalId)) as Array<Record<string, unknown>>;
  // メンバーには自分の見える範囲にある担当だけ返す (2026-11-05 監査: 同僚の担当が全部見えていた)
  const roots = await viewRoots(wctx);
  if (roots !== null) {
    const visible = new Set(((await listGoals(wctx.workspaceId, roots)) as { id: string }[]).map((g) => g.id));
    rows = rows.filter((r) => visible.has(r.id as string));
  }
  return json(rows.map((r) => ({ ...r, can_edit: !!r.can_edit })));
}
