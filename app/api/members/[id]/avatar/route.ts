import { requireWorkspace } from "../../../../lib/server/workspace";
import { getMemberAvatar } from "../../../../lib/server/queries";
import { AVATAR_TYPES } from "../../../../lib/server/filesCore";

// Serves a member's avatar (stored as a base64 data URL in D1) as a cacheable
// image so the tree's assignee batch can carry a short URL instead of 40KB blobs.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const avatar = await getMemberAvatar(id, wctx.workspaceId);
  if (!avatar) return new Response("not found", { status: 404 });
  // 画像の data URL 以外は出さない (外部 URL へのリダイレクトも、HTML/SVG の配信もしない)
  const m = avatar.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+=*)$/);
  if (!m || !AVATAR_TYPES.has(m[1])) return new Response("not found", { status: 404 });
  const etag = `"${id}-${avatar.length}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  let body: ArrayBuffer;
  try { body = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)).buffer as ArrayBuffer; } catch { return new Response("not found", { status: 404 }); }
  return new Response(body, {
    headers: {
      "content-type": m[1],
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, max-age=86400",
      etag,
    },
  });
}
