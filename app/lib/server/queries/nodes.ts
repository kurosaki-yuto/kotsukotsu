import "server-only";
import { createNotification } from "./notifications";
import { computeStreak } from "./misc";
import { cascadeGoalDone, cascadeNodeDone } from "./goals";
import { all, first, run, batch, uid, nowIso } from "../db";

// ---------------- nodes (subtasks) ----------------
export async function listProjectNodes(projectId: string, wsId: string) {
  return all("SELECT * FROM nodes WHERE project_id = ? AND workspace_id = ? ORDER BY order_idx ASC", projectId, wsId);
}

async function siblings(projectId: string, parentId: string | null) {
  return parentId === null
    ? all<{ id: string; order_idx: number; parent_id: string | null }>(
        "SELECT id, order_idx, parent_id FROM nodes WHERE project_id = ? AND parent_id IS NULL ORDER BY order_idx ASC", projectId)
    : all<{ id: string; order_idx: number; parent_id: string | null }>(
        "SELECT id, order_idx, parent_id FROM nodes WHERE project_id = ? AND parent_id = ? ORDER BY order_idx ASC", projectId, parentId);
}
async function repack(projectId: string, parentId: string | null) {
  const rows = await siblings(projectId, parentId);
  const stmts = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => r.order_idx !== i)
    .map(({ r, i }) => ({ sql: "UPDATE nodes SET order_idx = ? WHERE id = ?", args: [i, r.id] }));
  await batch(stmts);
  return rows;
}

export async function insertNodeAfter(opts: { id?: string; projectId: string; parentId: string | null; afterId: string | null; text?: string; wsId: string }) {
  const id = opts.id ?? uid();
  const sibs = await repack(opts.projectId, opts.parentId);
  const insertAt = opts.afterId == null ? 0 : sibs.findIndex((s) => s.id === opts.afterId) + 1;
  const shifts = sibs.filter((_, i) => i >= insertAt).map((s) => ({ sql: "UPDATE nodes SET order_idx = order_idx + 1 WHERE id = ?", args: [s.id] }));
  await batch(shifts);
  await run(
    "INSERT INTO nodes (id, project_id, parent_id, text, order_idx, workspace_id) VALUES (?,?,?,?,?,?)",
    id, opts.projectId, opts.parentId, opts.text ?? "", insertAt, opts.wsId
  );
  return first("SELECT * FROM nodes WHERE id = ?", id);
}
export async function updateNodeText(id: string, text: string, wsId: string) {
  await run("UPDATE nodes SET text = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", text, nowIso(), id, wsId);
}
export async function deleteNode(id: string, wsId: string) {
  const n = await first<{ project_id: string; parent_id: string | null }>("SELECT project_id, parent_id FROM nodes WHERE id = ? AND workspace_id = ?", id, wsId);
  await run("DELETE FROM nodes WHERE id = ? AND workspace_id = ?", id, wsId);
  if (n) await repack(n.project_id, n.parent_id);
}
export async function toggleNodeComplete(id: string, completed: boolean, wsId: string) {
  await run("UPDATE nodes SET completed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", completed ? nowIso() : null, nowIso(), id, wsId);
  if (!completed) return;
  // 下にぶら下がる小タスクも一緒に閉じる。残すと親だけ消えて子が上に浮く。
  // 「全部終わったか」の判定より先にやること (子を数え漏らす)。
  await cascadeNodeDone(id, wsId);
  // --- events: points + notification + goal-complete + streak ---
  const node = await first<{ text: string; project_id: string; gname: string | null }>(
    "SELECT n.text AS text, n.project_id AS project_id, p.name AS gname FROM nodes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = ? AND n.workspace_id = ?",
    id, wsId
  );
  await run("UPDATE members SET points = points + 1 WHERE is_you = 1 AND workspace_id = ?", wsId);
  if (node?.text?.trim()) {
    await createNotification({ kind: "goal", title: "タスク完了", body: `「${node.text.trim()}」を完了しました`, goal_id: node.project_id });
  }
  if (node?.project_id) {
    const prog = await first<{ total: number; done: number }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS done FROM nodes WHERE project_id = ? AND workspace_id = ?",
      node.project_id, wsId
    );
    if (prog && prog.total > 0 && prog.done === prog.total) {
      await run("UPDATE members SET points = points + 10 WHERE is_you = 1 AND workspace_id = ?", wsId);
      await run("UPDATE projects SET status = 'done' WHERE id = ? AND workspace_id = ?", node.project_id, wsId);
      // 小タスクが全部終わってゴールが閉じるときも、配下のゴールと小タスクを連れていく。
      await cascadeGoalDone(node.project_id, wsId);
      await createNotification({ kind: "streak", title: "大ゴール達成", body: `「${node.gname ?? "ゴール"}」のタスクをすべて完了しました`, goal_id: node.project_id });
    } else {
      // reopen if it was marked done
      await run("UPDATE projects SET status = 'active' WHERE id = ? AND status = 'done' AND workspace_id = ?", node.project_id, wsId);
    }
  }
  const s = await computeStreak(wsId);
  await run("UPDATE members SET streak = ? WHERE is_you = 1 AND workspace_id = ?", s, wsId);
}

export async function indentNode(id: string) {
  const node = await first<{ id: string; project_id: string; parent_id: string | null; order_idx: number }>("SELECT * FROM nodes WHERE id = ?", id);
  if (!node) return null;
  const prev = node.parent_id === null
    ? await first<{ id: string }>("SELECT id FROM nodes WHERE project_id=? AND parent_id IS NULL AND order_idx < ? ORDER BY order_idx DESC LIMIT 1", node.project_id, node.order_idx)
    : await first<{ id: string }>("SELECT id FROM nodes WHERE project_id=? AND parent_id=? AND order_idx < ? ORDER BY order_idx DESC LIMIT 1", node.project_id, node.parent_id, node.order_idx);
  if (!prev) return null;
  const last = await first<{ m: number | null }>("SELECT MAX(order_idx) AS m FROM nodes WHERE project_id=? AND parent_id=?", node.project_id, prev.id);
  const newIdx = (last?.m ?? -1) + 1;
  await run("UPDATE nodes SET parent_id=?, order_idx=? WHERE id=?", prev.id, newIdx, id);
  await repack(node.project_id, node.parent_id);
  return null;
}

export async function outdentNode(id: string) {
  const node = await first<{ id: string; project_id: string; parent_id: string | null; order_idx: number }>("SELECT * FROM nodes WHERE id = ?", id);
  if (!node || node.parent_id == null) return null;
  const parent = await first<{ id: string; parent_id: string | null; order_idx: number }>("SELECT id, parent_id, order_idx FROM nodes WHERE id = ?", node.parent_id);
  if (!parent) return null;
  const gp = parent.parent_id;
  const later = gp === null
    ? await all<{ id: string }>("SELECT id FROM nodes WHERE project_id=? AND parent_id IS NULL AND order_idx > ? ORDER BY order_idx ASC", node.project_id, parent.order_idx)
    : await all<{ id: string }>("SELECT id FROM nodes WHERE project_id=? AND parent_id=? AND order_idx > ? ORDER BY order_idx ASC", node.project_id, gp, parent.order_idx);
  await batch(later.map((s) => ({ sql: "UPDATE nodes SET order_idx = order_idx + 1 WHERE id = ?", args: [s.id] })));
  await run("UPDATE nodes SET parent_id=?, order_idx=? WHERE id=?", gp, parent.order_idx + 1, id);
  await repack(node.project_id, node.parent_id);
  await repack(node.project_id, gp);
  return null;
}

export async function moveNode(opts: { id: string; newParentId: string | null; newIndex: number }) {
  const node = await first<{ id: string; project_id: string; parent_id: string | null }>("SELECT * FROM nodes WHERE id = ?", opts.id);
  if (!node) return;
  const oldParent = node.parent_id;
  const dest = (await siblings(node.project_id, opts.newParentId)).filter((r) => r.id !== opts.id);
  const clamped = Math.max(0, Math.min(opts.newIndex, dest.length));
  const reordered = [...dest.slice(0, clamped).map((d) => d.id), opts.id, ...dest.slice(clamped).map((d) => d.id)];
  await batch(reordered.map((rid, i) => ({
    sql: "UPDATE nodes SET order_idx = ?, parent_id = ? WHERE id = ?",
    args: [i, rid === opts.id ? opts.newParentId : opts.newParentId, rid],
  })));
  // ^ only the moved row changes parent; siblings already have newParentId
  await run("UPDATE nodes SET parent_id = ? WHERE id = ?", opts.newParentId, opts.id);
  if (oldParent !== opts.newParentId) await repack(node.project_id, oldParent);
}

// ---------------- today ----------------
// 「今日やる」は2つのテーブルに載っている。type: "goal" が生きているモデル
// (projects — `/` と `/goals/[id]` が描画しているもの)、type: "node" が旧
// アウトライナー (nodes — Outliner.tsx がどこからも import されておらず UI から
// 切れている)。today_date は長らく nodes 側にしか無かったため、今日の一覧は
// 常に空だった (データが無いのではなく線が繋がっていなかった)。
// 呼び出し側が type を見なくても壊れないよう、列名は揃えてある。
export async function listToday(date: string, wsId: string) {
  const goals = await all(
    `SELECT 'goal' AS type, p.id, p.name AS text, p.parent_goal_id AS project_id,
            par.name AS project_name, p.order_idx, p.status, p.completed_at,
            p.deadline, p.today_date, NULL AS estimate_min, NULL AS due_at
       FROM projects p LEFT JOIN projects par ON par.id = p.parent_goal_id
      WHERE p.today_date = ? AND p.workspace_id = ? ORDER BY p.order_idx ASC`, date, wsId
  );
  const nodes = await all(
    `SELECT 'node' AS type, n.*, p.name AS project_name FROM nodes n
     LEFT JOIN projects p ON p.id = n.project_id
     WHERE n.today_date = ? AND n.workspace_id = ? ORDER BY n.order_idx ASC`, date, wsId
  );
  return [...goals, ...nodes];
}
/** id はゴール(タスク)でも旧 node でもよい。先にゴールとして探す。 */
export async function setToday(id: string, date: string | null, wsId: string) {
  const asGoal = await first<{ id: string }>("SELECT id FROM projects WHERE id = ? AND workspace_id = ?", id, wsId);
  if (asGoal) {
    await run("UPDATE projects SET today_date = ? WHERE id = ? AND workspace_id = ?", date, id, wsId);
    return;
  }
  await run("UPDATE nodes SET today_date = ? WHERE id = ? AND workspace_id = ?", date, id, wsId);
}
export async function clearToday(date: string, wsId: string) {
  await run("UPDATE projects SET today_date = NULL WHERE today_date = ? AND workspace_id = ?", date, wsId);
  await run("UPDATE nodes SET today_date = NULL WHERE today_date = ? AND workspace_id = ?", date, wsId);
}

// ---------------- node due date / reminder ----------------
// Setting/changing due_at clears reminded_at so a re-scheduled task can remind
// again (the cron sweep only ever fires once per un-cleared reminded_at).
export async function updateNodeDue(id: string, dueAt: string | null, wsId: string) {
  await run("UPDATE nodes SET due_at = ?, reminded_at = NULL WHERE id = ? AND workspace_id = ?", dueAt, id, wsId);
}
