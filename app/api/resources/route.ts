import { json, bad, first } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { listResources, createResource, updateResource } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const goal = new URL(req.url).searchParams.get("goal");
  if (!goal) return bad("goal required", 400);
  if (!(await goalInScope(ctx.workspaceId, goal, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  return json(await listResources(goal, ctx.workspaceId));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { goalId?: string; name?: string; kind?: string; content?: string | null; url?: string | null };
  if (!body.goalId || !body.name) return bad("goalId and name required", 400);
  if (!(await goalInScope(ctx.workspaceId, body.goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  return json(await createResource(body.goalId, body.name, ctx.workspaceId, body.kind, body.content ?? null, body.url ?? null));
}

export async function PATCH(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; name?: string; content?: string | null; url?: string | null; kind?: string };
  if (!body.id) return bad("id required", 400);
  const r = await first<{ goal_id: string | null }>("SELECT goal_id FROM resources WHERE id = ? AND workspace_id = ?", body.id, ctx.workspaceId);
  if (!r) return json({ error: "not found" }, { status: 404 });
  if (r.goal_id && !(await goalInScope(ctx.workspaceId, r.goal_id, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const { id, ...patch } = body;
  await updateResource(id, patch, ctx.workspaceId);
  return json({ ok: true });
}
