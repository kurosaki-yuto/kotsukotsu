import { requireWorkspace } from "../../lib/server/workspace";
import { json } from "../../lib/server/db";
import { listDoneCounts } from "../../lib/server/queries";

// タスク画面の「終えたタスク」。メンバー全員の今日・今週の完了数 (数だけ)。タスク名は本人の分だけ
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await listDoneCounts(ctx.user.email, ctx.workspaceId));
}
