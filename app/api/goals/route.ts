import { json } from "../../lib/server/db";
import { requireWorkspace, viewRoots } from "../../lib/server/workspace";
import { listGoals, listTopGoals, createGoal, setGoalCreator, assignCreatorAsHolder } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  // 管理者は全部、それ以外は見える範囲 (招待の範囲か担当) の下だけ。上の親は名前も返さない
  const roots = await viewRoots(ctx);
  if (params.get("top")) return json(await listTopGoals(ctx.workspaceId, roots));
  return json(await listGoals(ctx.workspaceId, roots, params.get("active") === "1"));
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
