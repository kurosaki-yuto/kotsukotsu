import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { json, bad } from "../../lib/server/db";
import { listAttention, dismissClose, dismissStall, canEditGoal } from "../../lib/server/queries";

// タスク画面の「閉じていい？」と「止まっている」。見える範囲は「あなたの番」と同じ
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await listAttention(ctx.user, ctx.workspaceId, { admin: ctx.role === "admin", scopeGoalId: ctx.scopeGoalId }));
}

// 「まだ」(閉じていい？から外す) / 「確認した」(止まっているを消す)
export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  const id = String(body.id ?? "");
  if (!id) return bad("id がありません");
  if (!(await goalInScope(ctx.workspaceId, id, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (!(await canEditGoal({ id: ctx.user.id, email: ctx.user.email, role: ctx.role }, id, ctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  const ok = body.action === "keep_open" ? await dismissClose(id, ctx.workspaceId)
    : body.action === "ack_stall" ? await dismissStall(id, ctx.workspaceId)
    : null;
  if (ok === null) return bad("action は keep_open か ack_stall");
  if (!ok) return json({ error: "not found" }, { status: 404 });
  return json({ ok: true });
}
