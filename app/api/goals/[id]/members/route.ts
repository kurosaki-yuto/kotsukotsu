import { requireWorkspace, goalInScope } from "../../../../lib/server/workspace";
import { json } from "../../../../lib/server/db";
import { first } from "../../../../lib/server/db";
import { listGoalMembers, assignGoalMember, unassignGoalMember, setGoalMemberEdit } from "../../../../lib/server/queries";

// Only a workspace admin or the goal's creator may manage assignments/permissions.
async function canManage(user: { id: string; role: string }, goalId: string, wsId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const g = await first<{ created_by: string | null }>("SELECT created_by FROM projects WHERE id = ? AND workspace_id = ?", goalId, wsId);
  return !!g && g.created_by === user.id;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const rows = (await listGoalMembers(id, wctx.workspaceId)) as Array<Record<string, unknown>>;
  return json(rows.map((r) => ({ ...r, can_edit: !!r.can_edit, is_you: !!r.is_you })));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await canManage({ id: wctx.user.id, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { memberId?: string; canEdit?: boolean };
  if (!body.memberId) return json({ error: "memberId required" }, { status: 400 });
  await assignGoalMember(id, body.memberId, !!body.canEdit, true);
  return json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await canManage({ id: wctx.user.id, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { memberId?: string; canEdit?: boolean };
  if (!body.memberId) return json({ error: "memberId required" }, { status: 400 });
  await setGoalMemberEdit(id, body.memberId, !!body.canEdit);
  return json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await canManage({ id: wctx.user.id, role: wctx.role }, id, wctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  if (!(await goalInScope(wctx.workspaceId, id, wctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { memberId?: string };
  if (!body.memberId) return json({ error: "memberId required" }, { status: 400 });
  await unassignGoalMember(id, body.memberId);
  return json({ ok: true });
}
