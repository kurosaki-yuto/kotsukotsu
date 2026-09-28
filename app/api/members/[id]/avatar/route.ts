import { requireWorkspace } from "../../../../lib/server/workspace";
import { getMemberAvatar } from "../../../../lib/server/queries";

// Serves a member's avatar (stored as a base64 data URL in D1) as a cacheable
// image so the tree's assignee batch can carry a short URL instead of 40KB blobs.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const avatar = await getMemberAvatar(id, wctx.workspaceId);
  if (!avatar) return new Response("not found", { status: 404 });
  const m = avatar.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/);
  if (!m) return Response.redirect(avatar, 302);
  const etag = `"${id}-${avatar.length}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  const body = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : decodeURIComponent(m[3]);
  return new Response(body, { headers: { "content-type": m[1], "cache-control": "private, max-age=86400", etag } });
}
