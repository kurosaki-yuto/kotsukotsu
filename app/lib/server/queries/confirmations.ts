import "server-only";
import { all, first, run, nowIso } from "../db";
import { sendMessage } from "./chat";
import type { GoalConfirmation } from "../qualityCore";

// 完了の基準・現状の「これでいい？ はい / いいえ」(qualityCore.ts、黒崎判断 2026-11-02)。
// AI が書き換えるたびに積まれる。答えるのは AI を動かしていた本人 (と管理者・そのゴールを編集できる人)。

export type ConfirmationRow = GoalConfirmation & { goal_name: string | null; current_text: string | null };

const COLS = `c.*, p.name AS goal_name,
  CASE c.field WHEN 'completion_criteria' THEN p.completion_criteria ELSE p.current_state END AS current_text`;

/** 自分の AI が書いて、まだ答えていない確認 (新しい順)。アーカイブ済みのゴールの分は出さない。 */
export async function listMyConfirmations(wsId: string, userId: string, limit = 100): Promise<ConfirmationRow[]> {
  return all<ConfirmationRow>(
    `SELECT ${COLS} FROM goal_confirmations c JOIN projects p ON p.id = c.goal_id AND p.workspace_id = c.workspace_id
      WHERE c.workspace_id = ? AND c.requested_by = ? AND c.status = 'pending' AND p.status != 'archived'
      ORDER BY c.created_at DESC, c.id LIMIT ?`,
    wsId, userId, limit
  );
}

/** そのゴールのまだ答えていない確認 (誰の AI が書いたかを問わない)。 */
export async function listGoalConfirmations(wsId: string, goalId: string): Promise<ConfirmationRow[]> {
  return all<ConfirmationRow>(
    `SELECT ${COLS} FROM goal_confirmations c JOIN projects p ON p.id = c.goal_id AND p.workspace_id = c.workspace_id
      WHERE c.workspace_id = ? AND c.goal_id = ? AND c.status = 'pending'
      ORDER BY c.created_at DESC, c.id LIMIT 20`,
    wsId, goalId
  );
}

export async function getConfirmation(wsId: string, id: string): Promise<GoalConfirmation | null> {
  return first<GoalConfirmation>("SELECT * FROM goal_confirmations WHERE id = ? AND workspace_id = ?", id, wsId);
}

const LABEL: Record<string, string> = { completion_criteria: "完了の基準", current_state: "現状" };

/**
 * はい: まだ反映していなければ反映する。いいえ: 反映済みなら元に戻し、書き直しを頼むコメントをゴールに残す。
 * 戻すのは、今の中身がまだその確認の書き換えのままのときだけ (後から人や AI が直していたら上書きしない)。
 */
export async function answerConfirmation(
  wsId: string, c: GoalConfirmation, yes: boolean, by: { name: string | null; email: string | null }, note: string | null
): Promise<void> {
  const now = nowIso();
  const col = c.field === "completion_criteria" ? "completion_criteria" : "current_state";
  const at = c.field === "completion_criteria" ? "criteria_updated_at" : "state_updated_at";
  if (yes && !c.applied) {
    await run(`UPDATE projects SET ${col} = ?, ${at} = ? WHERE id = ? AND workspace_id = ?`, c.after_text, now, c.goal_id, wsId);
  }
  if (!yes && c.applied) {
    await run(
      `UPDATE projects SET ${col} = ?, ${at} = ? WHERE id = ? AND workspace_id = ? AND ${col} IS ?`,
      c.before_text, now, c.goal_id, wsId, c.after_text
    );
  }
  await run(
    "UPDATE goal_confirmations SET status = ?, decided_at = ?, decided_by_name = ? WHERE id = ? AND workspace_id = ? AND status = 'pending'",
    yes ? "accepted" : "rejected", now, by.name ?? by.email ?? "メンバー", c.id, wsId
  );
  if (!yes) {
    const body =
      `${LABEL[c.field]}の書き換えは「いいえ」でした${c.applied ? " (元に戻しました)" : " (反映していません)"}。` +
      (note?.trim() ? `\n理由: ${note.trim().slice(0, 1000)}` : "") +
      `\nAI へ: この${LABEL[c.field]}を書き直して、もう一度 update_goal で出してください。`;
    await sendMessage(c.goal_id, body, wsId, "user", by.name ?? "メンバー", by.email);
  }
}
