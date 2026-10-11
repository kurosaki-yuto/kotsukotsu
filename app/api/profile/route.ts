import { requireWorkspace } from "../../lib/server/workspace";
import { json } from "../../lib/server/db";
import { getMyProfile, updateMyAvatar } from "../../lib/server/queries";
import { validAvatar } from "../../lib/server/filesCore";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await getMyProfile(ctx.user, ctx.workspaceId));
}

export async function PATCH(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { avatar?: unknown };
  const avatar = body.avatar ?? null;
  // 画像の data URL だけ。text/html や SVG を入れると本体オリジンでスクリプトが動く
  if (!validAvatar(avatar)) return json({ error: "アバターは PNG / JPEG / WebP / GIF の画像 (150KB まで) だけです" }, { status: 400 });
  await updateMyAvatar(ctx.user, avatar, ctx.workspaceId);
  return json({ ok: true });
}
