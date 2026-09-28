import { json } from "../../../lib/server/db";
import { requireWorkspace } from "../../../lib/server/workspace";
import { updateMember, removeMember } from "../../../lib/server/queries";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  if (wctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  await updateMember(id, patch, wctx.workspaceId);
  return json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  if (wctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  await removeMember(id, wctx.workspaceId);
  return json({ ok: true });
}
