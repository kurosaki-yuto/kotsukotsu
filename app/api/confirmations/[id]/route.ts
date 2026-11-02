import { json, bad } from "../../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../../lib/server/workspace";
import { getConfirmation, answerConfirmation, canEditGoal } from "../../../lib/server/queries";
import { notifyWorkspace } from "../../../lib/server/realtime";

// 「これでいい？」に答える。{ answer: "yes" | "no", note? }。
// 答えられるのは、AI を動かしていた本人・管理者・そのゴールを編集できる人。
export async function POST(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const conf = await getConfirmation(ctx.workspaceId, id);
  if (!conf || !(await goalInScope(ctx.workspaceId, conf.goal_id, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  const mine = !!conf.requested_by && conf.requested_by === ctx.user.id;
  if (!mine && !(await canEditGoal({ id: ctx.user.id, email: ctx.user.email, role: ctx.role }, conf.goal_id, ctx.workspaceId))) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  if (conf.status !== "pending") return bad("この確認はもう答えられています (新しい書き換えに置き換わったか、答え済み)", 409);
  const body = (await req.json().catch(() => null)) as { answer?: unknown; note?: unknown } | null;
  if (body?.answer !== "yes" && body?.answer !== "no") return bad("answer は yes か no", 400);
  await answerConfirmation(ctx.workspaceId, conf, body.answer === "yes", { name: ctx.user.name, email: ctx.user.email }, typeof body.note === "string" ? body.note : null);
  notifyWorkspace(ctx.workspaceId);
  return json({ ok: true });
}
