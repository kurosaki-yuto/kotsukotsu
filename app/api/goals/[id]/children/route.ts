import { json } from "../../../../lib/server/db";
import { requireWorkspace, goalInScope, requireGoalEdit } from "../../../../lib/server/workspace";
import { listChildren, createChild, assignCreatorAsHolder } from "../../../../lib/server/queries";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  return json(await listChildren(id, wctx.workspaceId));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const denied = await requireGoalEdit(wctx, id); if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const child = (await createChild(id, body.name ?? "", wctx.workspaceId, wctx.user.id)) as { id: string } | null;
  if (!child?.id) return json({ error: "not found" }, { status: 404 }); // 親が無い・削除済み
  await assignCreatorAsHolder(child.id, wctx.user, wctx.workspaceId); // creator becomes manager + holder
  return json(child);
}
