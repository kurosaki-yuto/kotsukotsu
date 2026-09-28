import { json, bad } from "../../../lib/server/db";
import { requireWorkspace, goalInScope, type WorkspaceCtx } from "../../../lib/server/workspace";
import { getMessage, updateMessage, deleteMessage, getMyProfile } from "../../../lib/server/queries";

// Only the comment's author may edit or delete it (admins can delete for
// moderation, but editing stays author-only — an edit is speech in someone
// else's name). Old rows predating author_email fall back to a display-name
// match against the caller's profile.
async function canTouch(ctx: WorkspaceCtx, msg: { author: string | null; author_email: string | null }, forDelete: boolean): Promise<boolean> {
  const email = ctx.user.email?.toLowerCase().trim();
  if (msg.author_email && email && msg.author_email === email) return true;
  if (!msg.author_email && msg.author) {
    const myName = (await getMyProfile(ctx.user, ctx.workspaceId)).name || ctx.user.name;
    if (myName && msg.author === myName) return true;
  }
  return forDelete && ctx.role === "admin";
}

export async function PATCH(req: Request, route: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await route.params;
  const body = (await req.json().catch(() => ({}))) as { body?: string };
  if (!body.body?.trim()) return bad("body required", 400);
  const msg = await getMessage(id, ctx.workspaceId);
  if (!msg || !(await goalInScope(ctx.workspaceId, msg.goal_id ?? "", ctx.scopeGoalId))) {
    return json({ error: "not found" }, { status: 404 });
  }
  if (!(await canTouch(ctx, msg, false))) return json({ error: "forbidden" }, { status: 403 });
  return json(await updateMessage(id, body.body.trim(), ctx.workspaceId));
}

export async function DELETE(req: Request, route: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await route.params;
  const msg = await getMessage(id, ctx.workspaceId);
  if (!msg || !(await goalInScope(ctx.workspaceId, msg.goal_id ?? "", ctx.scopeGoalId))) {
    return json({ error: "not found" }, { status: 404 });
  }
  if (!(await canTouch(ctx, msg, true))) return json({ error: "forbidden" }, { status: 403 });
  await deleteMessage(id, ctx.workspaceId);
  return json({ ok: true });
}
