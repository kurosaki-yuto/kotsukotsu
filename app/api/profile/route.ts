import { requireWorkspace } from "../../lib/server/workspace";
import { json } from "../../lib/server/db";
import { getMyProfile, updateMyAvatar } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await getMyProfile(ctx.user, ctx.workspaceId));
}

export async function PATCH(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { avatar?: string | null };
  await updateMyAvatar(ctx.user, body.avatar ?? null, ctx.workspaceId);
  return json({ ok: true });
}
