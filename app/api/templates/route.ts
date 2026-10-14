import { json, bad } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { listTemplates, createTemplate, getGoal, canEditGoal, exportKata } from "../../lib/server/queries";
import { snapshotGoalTree } from "../../lib/server/templateCore";
import { db } from "../../lib/server/db";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await listTemplates(ctx.workspaceId));
}

// 型を作る。{ from_goal_id } ならそのゴールのタスク木を写して作る。それ以外は手入力の中身で作る。
export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return bad("invalid body", 400);
  const user = { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };

  const fromGoalId = typeof body.from_goal_id === "string" ? body.from_goal_id : null;
  if (fromGoalId) {
    if (!(await goalInScope(ctx.workspaceId, fromGoalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
    if (!(await canEditGoal({ id: ctx.user.id, email: ctx.user.email, role: ctx.role }, fromGoalId, ctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
    const goal = (await getGoal(fromGoalId, ctx.workspaceId)) as { name: string; completion_criteria: string | null; current_state: string | null } | null;
    if (!goal) return json({ error: "not found" }, { status: 404 });
    const tasks = await snapshotGoalTree(db(), ctx.workspaceId, fromGoalId);
    const t = await createTemplate(ctx.workspaceId, {
      name: goal.name,
      completion_criteria: goal.completion_criteria,
      tasks,
      source_goal_id: fromGoalId,
    }, user);
    await exportKata(t.id, ctx.workspaceId);
    return json(t);
  }

  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const t = await createTemplate(ctx.workspaceId, {
    name: typeof body.name === "string" ? body.name : "",
    purpose: typeof body.purpose === "string" ? body.purpose : null,
    completion_criteria: typeof body.completion_criteria === "string" ? body.completion_criteria : null,
    inputs: body.inputs,
    tasks: body.tasks,
    resources: body.resources,
    cautions: body.cautions,
  }, user);
  await exportKata(t.id, ctx.workspaceId);
  return json(t);
}
