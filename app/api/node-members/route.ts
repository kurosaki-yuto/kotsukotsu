import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { json, bad, first } from "../../lib/server/db";
import { listNodeMembersByGoal, assignNodeMember, unassignNodeMember, nodeGoalId } from "../../lib/server/queries";

async function canManageGoal(user: { id: string; role: string }, goalId: string, wsId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const g = await first<{ created_by: string | null }>("SELECT created_by FROM projects WHERE id = ? AND workspace_id = ?", goalId, wsId);
  return !!g && g.created_by === user.id;
}

// GET ?goal=ID -> flat rows [{node_id, id, name, email, avatar, is_you}]
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const goal = new URL(req.url).searchParams.get("goal");
  if (!goal) return bad("goal required", 400);
  if (!(await goalInScope(ctx.workspaceId, goal, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const rows = (await listNodeMembersByGoal(goal, ctx.workspaceId)) as Array<Record<string, unknown>>;
  return json(rows.map((r) => ({ ...r, is_you: !!r.is_you })));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { nodeId?: string; memberId?: string };
  if (!body.nodeId || !body.memberId) return bad("nodeId and memberId required", 400);
  const goalId = await nodeGoalId(body.nodeId, ctx.workspaceId);
  if (!goalId) return bad("node not found", 404);
  if (!(await canManageGoal({ id: ctx.user.id, role: ctx.role }, goalId, ctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  if (!(await goalInScope(ctx.workspaceId, goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  await assignNodeMember(body.nodeId, body.memberId);
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { nodeId?: string; memberId?: string };
  if (!body.nodeId || !body.memberId) return bad("nodeId and memberId required", 400);
  const goalId = await nodeGoalId(body.nodeId, ctx.workspaceId);
  if (!goalId) return bad("node not found", 404);
  if (!(await canManageGoal({ id: ctx.user.id, role: ctx.role }, goalId, ctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  if (!(await goalInScope(ctx.workspaceId, goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  await unassignNodeMember(body.nodeId, body.memberId);
  return json({ ok: true });
}
