import { json } from "../../lib/server/db";
import { requireWorkspace } from "../../lib/server/workspace";
import { listGoals, listTopGoals, createGoal, setGoalCreator, assignCreatorAsHolder } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const top = new URL(req.url).searchParams.get("top");
  return json(top ? await listTopGoals(ctx.workspaceId, ctx.scopeGoalId) : await listGoals(ctx.workspaceId, ctx.scopeGoalId));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 }); // only admins create goals/tasks
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const goal = (await createGoal(body.name ?? "", ctx.workspaceId)) as { id: string } | null;
  if (goal?.id) {
    await setGoalCreator(goal.id, ctx.user.id, ctx.workspaceId);
    await assignCreatorAsHolder(goal.id, ctx.user, ctx.workspaceId); // creator becomes manager + holder
  }
  return json(goal);
}
