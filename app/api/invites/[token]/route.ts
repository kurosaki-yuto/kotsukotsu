import { requireWorkspace } from "../../../lib/server/workspace";
import { json } from "../../../lib/server/db";
import { getInvite, revokeInvite } from "../../../lib/server/queries";

// Public: validate an invite token (used by the join/login page). The reason
// lets the page tell "expired" apart from a bad URL. Links are multi-use, so
// prior acceptance never invalidates them.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const inv = await getInvite(token);
  if (!inv) return json({ valid: false, reason: "notfound" });
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) return json({ valid: false, reason: "expired" });
  return json({ valid: true, email: inv.email, role: inv.role });
}

// Admin: revoke an invite (scoped to the admin's active workspace).
export async function DELETE(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  if (wctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const { token } = await ctx.params;
  await revokeInvite(token, wctx.workspaceId);
  return json({ ok: true });
}
