import { json, bad, db, first, nowIso } from "../../../../lib/server/db";
import { requireWorkspace, goalInScope, requireGoalEdit } from "../../../../lib/server/workspace";
import { getTemplate, canEditGoal, createNotification } from "../../../../lib/server/queries";
import { applyTemplate, normalizeValues, missingRequiredInputs, substitute } from "../../../../lib/server/templateCore";
import { notifyWorkspace } from "../../../../lib/server/realtime";
import { limitOr429, HOUR } from "../../../../lib/server/ratelimit";

// 型をメンバーに振る: 親ゴールの下に 新ゴール + 子タスク + リソース + 担当 を一度に作る。
export async function POST(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const tpl = await getTemplate(id, ctx.workspaceId);
  if (!tpl || tpl.archived_at) return json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { parentId?: unknown; memberId?: unknown; values?: unknown; deadline?: unknown } | null;
  if (!body || typeof body !== "object") return bad("invalid body", 400);
  const parentId = typeof body.parentId === "string" ? body.parentId : "";
  const memberId = typeof body.memberId === "string" ? body.memberId : "";
  if (!parentId || !memberId) return bad("parentId and memberId required", 400);
  const denied = await requireGoalEdit(ctx, parentId); if (denied) return denied;

  const limited = await limitOr429(`apply:user:${ctx.user.id}`, 60, HOUR);
  if (limited) return limited;
  const member = await first<{ id: string; name: string; email: string | null; is_ai: number }>(
    "SELECT id, name, email, is_ai FROM members WHERE id = ? AND workspace_id = ?", memberId, ctx.workspaceId
  );
  if (!member) return bad("member not found", 404);

  const values = normalizeValues(body.values, tpl.inputs);
  const missing = missingRequiredInputs(tpl.inputs, values);
  if (missing.length) return json({ error: `必須の入力が空です: ${missing.join("、")}`, missing }, { status: 400 });
  const deadline = typeof body.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.deadline) ? body.deadline : null;

  const { rootId, created } = await applyTemplate(db(), ctx.workspaceId, tpl, {
    parentId,
    memberId: member.id,
    memberName: member.name,
    values,
    creatorUserId: ctx.user.id,
    creatorName: ctx.user.name,
    deadline,
    now: nowIso(),
  });

  // 担当者本人に「振られた」と知らせる (本人宛てなので他の人には出ない)
  if (member.email) {
    await createNotification(
      { kind: "mention", title: `型「${substitute(tpl.name, values) || tpl.name}」のタスクが振られました`, body: `${ctx.user.name ?? ctx.user.email} → ${member.name}。タスク ${created} 件`, goal_id: rootId, targetEmail: member.email },
      ctx.workspaceId
    );
  }
  notifyWorkspace(ctx.workspaceId);
  return json({ goalId: rootId, created });
}
