import { requireWorkspace } from "../../lib/server/workspace";
import { json } from "../../lib/server/db";
import { listMyTurn } from "../../lib/server/queries";

// タスク画面の「あなたの番」。現状の「ボール:」に本人の名前があるタスク
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await listMyTurn(ctx.user, ctx.workspaceId, { admin: ctx.role === "admin", scopeGoalId: ctx.scopeGoalId }));
}
