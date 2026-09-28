import { json } from "../../../lib/server/db";
import { requireWorkspace } from "../../../lib/server/workspace";
import { markRead } from "../../../lib/server/queries";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  await markRead(id, wctx.workspaceId, wctx.user.email);
  return json({ ok: true });
}
