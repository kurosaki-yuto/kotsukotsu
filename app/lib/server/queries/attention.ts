import "server-only";
import { all, first, run, runChanges, uid, nowIso, db } from "../db";
import { sweepStalled, CLEAR_STALL_SET } from "../../stall";

// ---------------- 作業の手順 (task_steps) ----------------
// AI が作業を始めるときに切る手順。子タスクにすると人が頼んだタスクと同じ盤に並ぶので、タスクの中のチェックリストとして持つ。
export type TaskStep = { id: string; task_id: string; text: string; order_idx: number; created_at: string; done_at: string | null; created_by: string | null };

export async function listSteps(taskId: string, wsId: string): Promise<TaskStep[]> {
  return all<TaskStep>("SELECT * FROM task_steps WHERE task_id = ? AND workspace_id = ? ORDER BY order_idx, created_at", taskId, wsId);
}

/** 手順のチェックを付け外しする。動いたのでタスクの「止まっている」も消す。見つからなければ null */
export async function setStepDone(stepId: string, done: boolean, wsId: string): Promise<string | null> {
  const s = await first<{ task_id: string }>("SELECT task_id FROM task_steps WHERE id = ? AND workspace_id = ?", stepId, wsId);
  if (!s) return null;
  await run("UPDATE task_steps SET done_at = ? WHERE id = ? AND workspace_id = ?", done ? nowIso() : null, stepId, wsId);
  await run(`UPDATE projects SET ${CLEAR_STALL_SET} WHERE id = ? AND workspace_id = ? AND stalled_at IS NOT NULL`, s.task_id, wsId);
  return s.task_id;
}

export async function addStep(taskId: string, text: string, wsId: string, by: string | null): Promise<void> {
  const max = await first<{ m: number }>("SELECT COALESCE(MAX(order_idx), -1) AS m FROM task_steps WHERE task_id = ? AND workspace_id = ?", taskId, wsId);
  await run(
    "INSERT INTO task_steps (id, task_id, workspace_id, text, order_idx, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    uid(), taskId, wsId, text, (max?.m ?? -1) + 1, nowIso(), by
  );
  await run(`UPDATE projects SET ${CLEAR_STALL_SET} WHERE id = ? AND workspace_id = ? AND stalled_at IS NOT NULL`, taskId, wsId);
}

// ---------------- タスク画面の「片付け」: 閉じていい？ / 止まっている ----------------
// 見える範囲は「あなたの番」(listMyTurn) と同じ: 管理者はワークスペース全体、それ以外は担当しているタスクとその配下、
// 招待で範囲が決まっている人はその範囲だけ (権限の仕様は変えない)。
export async function visibility(viewerEmail: string, wsId: string, opts: { admin: boolean; scopeGoalId: string | null }): Promise<{ sql: string; args: unknown[]; parentName: (alias: string) => string } | null> {
  // 上の親は見える範囲の中のときだけ名前を返す (見える根の親は名前も出さない)
  const within = (set: string) => (alias: string) => `CASE WHEN ${alias}.id IN ${set} THEN ${alias}.name END`;
  if (opts.scopeGoalId) {
    const set = `(WITH RECURSIVE down(id) AS (SELECT ? UNION SELECT c.id FROM down CROSS JOIN projects c ON c.parent_goal_id = down.id WHERE c.workspace_id = ?) SELECT id FROM down)`;
    return { sql: `p.id IN ${set}`, args: [opts.scopeGoalId, wsId], parentName: within(set) };
  }
  if (opts.admin) return { sql: "1 = 1", args: [], parentName: (alias) => `${alias}.name` };
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", viewerEmail.toLowerCase().trim(), wsId);
  if (!m) return null;
  const set = `(WITH RECURSIVE down(id) AS (
        SELECT gm.goal_id FROM goal_members gm WHERE gm.member_id = ?
        UNION SELECT c.id FROM down CROSS JOIN projects c ON c.parent_goal_id = down.id WHERE c.workspace_id = ?) SELECT id FROM down)`;
  return { sql: `p.id IN ${set}`, args: [m.id, wsId], parentName: within(set) };
}

// 現状に「終わった」と書いてあるのに開いたままのもの。完了の関門 (照合) に止められたまま、
// セッションが終わって残ったタスクが自分でこう書いている (11/1 本番で15件)。FAIL が書いてあるものは出さない
const DONE_WORDS = ["%照合%PASS%", "%作業は済み%", "%完了チェックはまだ%", "%完了の印を付けられていない%", "%完了の関門%"];

const COMPANY_WORDS = ["%株式会社%", "%合同会社%", "%有限会社%", "%（株）%", "%(株)%"];

export type ClosableItem = {
  id: string; name: string; parent_name: string | null; state_updated_at: string | null;
  reason: "children_done" | "steps_done" | "state_says_done"; detail: string;
};
export type StalledItem = { id: string; name: string; parent_name: string | null; stalled_at: string; stalled_note: string | null };

export async function listAttention(
  viewer: { email: string }, wsId: string, opts: { admin: boolean; scopeGoalId: string | null }
): Promise<{ closable: ClosableItem[]; stalled: StalledItem[] }> {
  // 画面を開いたついでに、このワークスペースの止まったタスクを切り替える (Docker 版には cron が無いため。Cloudflare 版は MCP の cron も回す)
  await sweepStalled(db(), new Date(), wsId);
  const vis = await visibility(viewer.email, wsId, opts);
  if (!vis) return { closable: [], stalled: [] };

  const notDismissed = "(p.close_dismissed_at IS NULL OR p.close_dismissed_at < coalesce(p.state_updated_at, ''))";
  const base = `p.workspace_id = ? AND p.status = 'active' AND p.archived_at IS NULL AND ${notDismissed} AND ${vis.sql}`;
  const kids = `(SELECT COUNT(*) FROM projects c WHERE c.parent_goal_id = p.id AND c.workspace_id = p.workspace_id AND c.status != 'archived')`;
  const openKids = `(SELECT COUNT(*) FROM projects c WHERE c.parent_goal_id = p.id AND c.workspace_id = p.workspace_id AND c.status = 'active')`;
  const steps = `(SELECT COUNT(*) FROM task_steps s WHERE s.task_id = p.id)`;
  const openSteps = `(SELECT COUNT(*) FROM task_steps s WHERE s.task_id = p.id AND s.done_at IS NULL)`;
  // 親の名前の判定 (SELECT 側) の引数が先に来るので、各クエリは vis.args を頭にも渡す
  const cols = `p.id, p.name, ${vis.parentName("par")} AS parent_name, p.state_updated_at, p.current_state`;
  const from = "FROM projects p LEFT JOIN projects par ON par.id = p.parent_goal_id";

  type Row = { id: string; name: string; parent_name: string | null; state_updated_at: string | null; current_state: string | null; n?: number };
  const [kidsDone, stepsDone, stateDone, stalled] = await Promise.all([
    // 配下が全部終わった中間のタスク。一番上のゴールと顧客の箱 (社名のゴール) は、今の配下が片付いても付き合いが続くので出さない
    // (11/1 本番で顧客の社名のゴール 2 件が候補に出た)
    all<Row>(
      `SELECT ${cols}, ${kids} AS n ${from} WHERE ${base} AND p.parent_goal_id IS NOT NULL AND ${kids} > 0 AND ${openKids} = 0
         AND ${COMPANY_WORDS.map(() => "p.name NOT LIKE ?").join(" AND ")}`,
      ...vis.args, wsId, ...vis.args, ...COMPANY_WORDS
    ),
    all<Row>(`SELECT ${cols}, ${steps} AS n ${from} WHERE ${base} AND ${steps} > 0 AND ${openSteps} = 0 AND ${openKids} = 0`, ...vis.args, wsId, ...vis.args),
    all<Row>(
      `SELECT ${cols} ${from} WHERE ${base} AND ${openKids} = 0 AND p.current_state NOT LIKE '%FAIL%'
         AND (${DONE_WORDS.map(() => "p.current_state LIKE ?").join(" OR ")})`,
      ...vis.args, wsId, ...vis.args, ...DONE_WORDS
    ),
    all<{ id: string; name: string; parent_name: string | null; stalled_at: string; stalled_note: string | null }>(
      `SELECT p.id, p.name, ${vis.parentName("par")} AS parent_name, p.stalled_at, p.stalled_note ${from}
        WHERE p.workspace_id = ? AND p.status = 'active' AND p.stalled_at IS NOT NULL AND ${vis.sql}
        ORDER BY p.stalled_at DESC`,
      ...vis.args, wsId, ...vis.args
    ),
  ]);

  const seen = new Set<string>();
  const closable: ClosableItem[] = [];
  const push = (r: Row, reason: ClosableItem["reason"], detail: string) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    closable.push({ id: r.id, name: r.name, parent_name: r.parent_name, state_updated_at: r.state_updated_at, reason, detail });
  };
  // 現状に書いてある言葉が一番具体的なので先に拾う
  for (const r of stateDone) push(r, "state_says_done", doneLine(r.current_state));
  for (const r of stepsDone) push(r, "steps_done", `作業の手順が全部済んでいる (${r.n}/${r.n})`);
  for (const r of kidsDone) push(r, "children_done", `配下のタスクが全部終わっている (${r.n}件)`);
  // 古く放置されているものから
  closable.sort((a, b) => (a.state_updated_at ?? "").localeCompare(b.state_updated_at ?? ""));
  return { closable, stalled };
}

/** 現状のうち「済んだ」と書いた行を1行だけ見せる */
function doneLine(state: string | null): string {
  const lines = (state ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /PASS|作業は済み|完了チェックはまだ|完了の印|完了の関門/.test(l));
  return (hit ?? lines[0] ?? "").slice(0, 160);
}

/** 「まだ」: 現状が書き換わるまで「閉じていい？」に出さない */
export async function dismissClose(id: string, wsId: string): Promise<boolean> {
  return (await runChanges("UPDATE projects SET close_dismissed_at = ? WHERE id = ? AND workspace_id = ?", nowIso(), id, wsId)) > 0;
}

/** 「確認した」: 止まっている印を消す */
export async function dismissStall(id: string, wsId: string): Promise<boolean> {
  return (await runChanges(`UPDATE projects SET ${CLEAR_STALL_SET} WHERE id = ? AND workspace_id = ?`, id, wsId)) > 0;
}
