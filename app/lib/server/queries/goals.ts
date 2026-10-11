import "server-only";
import { createNotification } from "./notifications";
import { all, first, run, batch, uid, nowIso } from "../db";
import { ballRank, ballText, personKeys } from "../../ball";

// ---------------- goals (projects) ----------------
export async function listGoals(wsId: string, scopeGoalId: string | null = null, activeOnly = false) {
  const statusClause = activeOnly ? "status NOT IN ('archived', 'done')" : "status != 'archived'";
  if (!scopeGoalId) {
    return all(`SELECT id, name, order_idx, created_at, emoji, deadline, owner, status, archived_at, parent_goal_id, created_by, workspace_id, started_at, started_by_name, started_via FROM projects WHERE ${statusClause} AND workspace_id = ? ORDER BY order_idx ASC, created_at ASC`, wsId);
  }
  // scoped member: only the scope goal and its descendants
  return all(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM projects WHERE id = ? AND workspace_id = ?
       UNION ALL
       SELECT p.id FROM sub CROSS JOIN projects p ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?
     )
     SELECT id, name, order_idx, created_at, emoji, deadline, owner, status, archived_at, parent_goal_id, created_by, workspace_id, started_at, started_by_name, started_via FROM projects WHERE workspace_id = ? AND ${statusClause} AND id IN (SELECT id FROM sub)
     ORDER BY order_idx ASC, created_at ASC`,
    scopeGoalId, wsId, wsId, wsId
  );
}
export async function getGoal(id: string, wsId: string) {
  return first("SELECT * FROM projects WHERE id = ? AND workspace_id = ?", id, wsId);
}
export async function createGoal(name: string, wsId: string) {
  const c = await first<{ c: number }>("SELECT COUNT(*) AS c FROM projects WHERE workspace_id = ?", wsId);
  const id = uid();
  const nm = (name || "").trim() || "ここをタップして、達成したいゴールを入力しましょう！";
  await run(
    "INSERT INTO projects (id, name, order_idx, workspace_id) VALUES (?,?,?,?)",
    id, nm, c?.c ?? 0, wsId
  );
  return getGoal(id, wsId);
}
// parent_goal_id はここでは受けない。付け替えは moveGoal (循環・スコープ・ワークスペースを検査する) だけ。
const GOAL_COLS = new Set(["name","emoji","deadline","current_state","completion_criteria","owner","status","archived_at","order_idx"]);
const GOAL_STATUS = new Set(["active", "done", "archived"]);
export async function updateGoal(id: string, patch: Record<string, unknown>, wsId: string) {
  if ("status" in patch && !GOAL_STATUS.has(String(patch.status))) delete patch.status;
  if ("deadline" in patch && patch.deadline != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.deadline))) delete patch.deadline;
  if ("order_idx" in patch && !Number.isInteger(patch.order_idx)) delete patch.order_idx;
  for (const k of ["name", "emoji", "current_state", "completion_criteria", "owner"]) {
    if (k in patch && patch[k] != null && typeof patch[k] !== "string") delete patch[k];
    if (typeof patch[k] === "string" && (patch[k] as string).length > 20000) patch[k] = (patch[k] as string).slice(0, 20000);
  }
  const keys = Object.keys(patch).filter((k) => GOAL_COLS.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`);
  const binds: unknown[] = keys.map((k) => patch[k]);
  // 現状・完了の基準は、中身が実際に変わったときだけ更新日時を付ける
  // (画面はフォーカスが外れるたびに同じ値を送ってくるため)。SET の右辺は更新前の値を見る。
  const now = nowIso();
  if (keys.includes("current_state")) {
    sets.push("state_updated_at = CASE WHEN current_state IS NOT ? THEN ? ELSE state_updated_at END");
    binds.push(patch.current_state, now);
  }
  if (keys.includes("completion_criteria")) {
    sets.push("criteria_updated_at = CASE WHEN completion_criteria IS NOT ? THEN ? ELSE criteria_updated_at END");
    binds.push(patch.completion_criteria, now);
  }
  await run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`, ...binds, id, wsId);
}
// アーカイブは配下ごと落とす。自分の行だけ落とすと、残った子は親が一覧から
// 消えた状態で最上位へ浮き上がり、文脈のないタスクがトップに並ぶ
// (2026-09-12 に154件たまっていた)。
export async function archiveGoal(id: string, wsId: string) {
  await run(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM projects WHERE id = ? AND workspace_id = ?
       UNION
       SELECT c.id FROM sub CROSS JOIN projects c ON c.parent_goal_id = sub.id WHERE c.workspace_id = ?
     )
     UPDATE projects SET status='archived', archived_at=?
      WHERE workspace_id = ? AND id IN (SELECT id FROM sub)`,
    id, wsId, wsId, nowIso(), wsId
  );
}

// Re-parent and/or reorder a goal anywhere in the tree (newParentId = null ->
// top level). `beforeId` = insert immediately before that sibling; null/absent =
// append to the end. Guards against cycles (a goal can never move under itself
// or one of its own descendants). Siblings under the destination are reindexed
// to a contiguous 0..n so ordering stays clean. Returns false on an invalid move.
export async function moveGoal(id: string, newParentId: string | null, beforeId: string | null, wsId: string): Promise<boolean> {
  if (newParentId === id) return false;
  const self = await first<{ id: string }>("SELECT id FROM projects WHERE id = ? AND workspace_id = ?", id, wsId);
  if (!self) return false;
  if (newParentId) {
    const dest = await first<{ id: string }>("SELECT id FROM projects WHERE id = ? AND workspace_id = ?", newParentId, wsId);
    if (!dest) return false;
    await clearStartedOnParent(newParentId, wsId);
    // walk up from the destination; if we reach `id`, the destination is a
    // descendant of the node being moved -> cycle, reject.
    let cur: string | null = newParentId;
    let guard = 0;
    while (cur && guard++ < 1000) {
      if (cur === id) return false;
      const r: { parent_goal_id: string | null } | null =
        await first("SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?", cur, wsId);
      cur = r?.parent_goal_id ?? null;
    }
  }
  // existing siblings under the destination (excluding the moved node), in order
  const sibs = newParentId
    ? await all<{ id: string }>("SELECT id FROM projects WHERE parent_goal_id = ? AND status != 'archived' AND workspace_id = ? AND id <> ? ORDER BY order_idx ASC, created_at ASC", newParentId, wsId, id)
    : await all<{ id: string }>("SELECT id FROM projects WHERE parent_goal_id IS NULL AND status != 'archived' AND workspace_id = ? AND id <> ? ORDER BY order_idx ASC, created_at ASC", wsId, id);
  const order = sibs.map((s) => s.id);
  let insertAt = order.length;
  if (beforeId) {
    const idx = order.indexOf(beforeId);
    if (idx >= 0) insertAt = idx;
  }
  order.splice(insertAt, 0, id);
  await run("UPDATE projects SET parent_goal_id = ? WHERE id = ? AND workspace_id = ?", newParentId, id, wsId);
  await batch(order.map((sid, i) => ({ sql: "UPDATE projects SET order_idx = ? WHERE id = ? AND workspace_id = ?", args: [i, sid, wsId] })));
  return true;
}
export async function goalProgress(goalId: string, wsId: string) {
  const rows = await all<{ completed_at: string | null }>("SELECT completed_at FROM nodes WHERE project_id = ? AND workspace_id = ?", goalId, wsId);
  return { done: rows.filter((r) => r.completed_at).length, total: rows.length };
}

// ---------------- recursive items (goal == task; subtasks are child goals) ----------------
export async function listTopGoals(wsId: string, scopeGoalId: string | null = null) {
  // a scoped member's "top" is their single scope goal
  if (scopeGoalId) {
    return all("SELECT * FROM projects WHERE id = ? AND workspace_id = ? AND status != 'archived'", scopeGoalId, wsId);
  }
  return all("SELECT * FROM projects WHERE parent_goal_id IS NULL AND status != 'archived' AND workspace_id = ? ORDER BY order_idx ASC, created_at ASC", wsId);
}
export async function listChildren(parentId: string, wsId: string) {
  return all("SELECT * FROM projects WHERE parent_goal_id = ? AND status != 'archived' AND workspace_id = ? ORDER BY order_idx ASC, created_at ASC", parentId, wsId);
}
export async function createChild(parentId: string, name: string, wsId: string, userId?: string) {
  const c = await first<{ c: number }>("SELECT COUNT(*) AS c FROM projects WHERE parent_goal_id = ? AND workspace_id = ?", parentId, wsId);
  const id = uid();
  await run(
    "INSERT INTO projects (id, name, order_idx, parent_goal_id, created_by, workspace_id) VALUES (?,?,?,?,?,?)",
    id, (name || "").trim() || "新しいタスク", c?.c ?? 0, parentId, userId ?? null, wsId
  );
  await clearStartedOnParent(parentId, wsId);
  return getGoal(id, wsId);
}
export async function getAncestors(id: string, wsId: string) {
  const out: { id: string; name: string }[] = [];
  let cur: string | null = id;
  let guard = 0;
  while (cur && guard++ < 30) {
    const r: { id: string; name: string; parent_goal_id: string | null } | null =
      await first("SELECT id, name, parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?", cur, wsId);
    if (!r) break;
    out.unshift({ id: r.id, name: r.name });
    cur = r.parent_goal_id;
  }
  return out; // [root ... self]
}
export async function itemProgress(id: string, wsId: string) {
  const rows = await all<{ status: string }>("SELECT status FROM projects WHERE parent_goal_id = ? AND status != 'archived' AND workspace_id = ?", id, wsId);
  return { done: rows.filter((r) => r.status === "done").length, total: rows.length };
}
/**
 * ゴールを完了にしたときの後始末。閉じた親の下に未完のものを残さない。
 *
 * 対象は2種類ある。両方やらないと「終わったはずのゴールの中身」が一覧・検索・
 * 「今日」に出続け、親を閉じたのに小タスクだけが上に浮いて見える。
 *   - 配下のゴール (projects.parent_goal_id をたどった全部)
 *   - そのゴール自身と配下のゴールが持つ小タスク (nodes)
 *
 * archived には触らない (アーカイブ済みを done へ戻さない)。
 * 完了を外すときは伝播させない。1つ開き直しただけで、下の完了が全部消えるほうが困る。
 */
export async function cascadeGoalDone(id: string, wsId: string) {
  // 自分と配下のゴール
  await run(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM projects WHERE id = ?1 AND workspace_id = ?2
       UNION ALL
       SELECT p.id FROM sub CROSS JOIN projects p ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?2
     )
     UPDATE projects SET status = 'done', completed_at = COALESCE(completed_at, ?3)
      WHERE workspace_id = ?2 AND status = 'active' AND id IN (SELECT id FROM sub)`,
    id, wsId, nowIso()
  );
  // それらのゴールがぶら下げている小タスク
  await run(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM projects WHERE id = ?1 AND workspace_id = ?2
       UNION ALL
       SELECT p.id FROM sub CROSS JOIN projects p ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?2
     )
     UPDATE nodes SET completed_at = ?3, updated_at = ?3
      WHERE workspace_id = ?2 AND completed_at IS NULL AND project_id IN (SELECT id FROM sub)`,
    id, wsId, nowIso()
  );
}

/** 小タスクを完了にしたときの後始末。その下にぶら下がる小タスクも一緒に閉じる。 */
export async function cascadeNodeDone(id: string, wsId: string) {
  await run(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM nodes WHERE id = ?1 AND workspace_id = ?2
       UNION ALL
       SELECT n.id FROM sub CROSS JOIN nodes n ON n.parent_id = sub.id WHERE n.workspace_id = ?2
     )
     UPDATE nodes SET completed_at = ?3, updated_at = ?3
      WHERE workspace_id = ?2 AND completed_at IS NULL AND id IN (SELECT id FROM sub)`,
    id, wsId, nowIso()
  );
}

/**
 * タスクを「進行中」にする / 戻す。status は触らない (active のまま started_at だけ立てる)。
 * 開いた・編集した・コメントしただけでは呼ばない。人がボタンを押したか、AI が start_task を呼んだときだけ。
 * 既に進行中なら最初に始めた人・日時を上書きしない。
 *
 * 進行中は一番下の小タスク (未完了の子を持たないもの) にだけ付ける。ToDo と同じで、実際に手を動かすのは
 * 一番下だから。親 (顧客名などの箱) には付けないし、親に印も出さない (2026-09-29 黒崎指示)。
 * 子が足されて親になったタスクの開始は clearStartedOnParent で外す。
 */
export async function setProjectStarted(
  id: string, started: boolean, wsId: string,
  by: { userId: string | null; name: string | null; via: string }
) {
  if (started) {
    await run(
      `UPDATE projects SET started_at = ?, started_by = ?, started_by_name = ?, started_via = ?
        WHERE id = ? AND workspace_id = ? AND status = 'active' AND started_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM projects c WHERE c.parent_goal_id = projects.id AND c.workspace_id = projects.workspace_id AND c.status = 'active')`,
      nowIso(), by.userId, by.name, by.via, id, wsId
    );
  } else {
    await run(
      "UPDATE projects SET started_at = NULL, started_by = NULL, started_by_name = NULL, started_via = NULL WHERE id = ? AND workspace_id = ?",
      id, wsId
    );
  }
}

/** 子を足した・移した先の親は一番下ではなくなるので、進行中を外す */
export async function clearStartedOnParent(parentId: string | null, wsId: string) {
  if (!parentId) return;
  await run(
    "UPDATE projects SET started_at = NULL, started_by = NULL, started_by_name = NULL, started_via = NULL WHERE id = ? AND workspace_id = ? AND started_at IS NOT NULL",
    parentId, wsId
  );
}

export async function toggleProjectDone(id: string, done: boolean, wsId: string, byEmail: string | null = null) {
  // completed_at を残す (MCP の complete_subtask と同じ)。無いと「いつ終わったか」が
  // 分からず、ゴールの自動の進捗欄に「最近の完了」を出せない。
  // completed_by は「終えたタスク」の数え上げ用 (0025)。一緒に閉じる配下 (cascadeGoalDone) には入れない。
  await run(
    "UPDATE projects SET status = ?, completed_at = ?, completed_by = ? WHERE id = ? AND workspace_id = ?",
    done ? "done" : "active", done ? nowIso() : null, done && byEmail ? byEmail.toLowerCase().trim() : null, id, wsId
  );
  if (done) {
    await cascadeGoalDone(id, wsId);
    await run("UPDATE members SET points = points + 1 WHERE is_you = 1 AND workspace_id = ?", wsId);
    const it = await first<{ name: string; parent_goal_id: string | null }>("SELECT name, parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?", id, wsId);
    if (it?.name?.trim()) await createNotification({ kind: "goal", title: "完了", body: `「${it.name.trim()}」を完了しました`, goal_id: id });
  }
}
export async function listMyAssignedItems(user: { email: string }, wsId: string) {
  const email = user.email.toLowerCase().trim();
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", email, wsId);
  if (!m) return [];
  return all(
    `SELECT p.id, p.name, p.emoji, p.status, p.parent_goal_id, p.started_at, p.started_by_name, p.started_via,
            (SELECT COUNT(*) FROM projects c WHERE c.parent_goal_id = p.id AND c.workspace_id = p.workspace_id AND c.status = 'active') AS open_children,
            parent.name AS parent_name, parent.emoji AS parent_emoji
     FROM goal_members gm
     JOIN projects p ON p.id = gm.goal_id
     LEFT JOIN projects parent ON parent.id = p.parent_goal_id
     WHERE gm.member_id = ? AND p.status != 'archived' AND p.workspace_id = ?
     ORDER BY (p.status = 'done') ASC, parent.name ASC, p.order_idx ASC`,
    m.id, wsId
  );
}

// 「あなたの番」: 現状の「ボール:」の行に本人の名前があるタスク (lib/ball.ts)。
// 見える範囲はほかの一覧と同じ: 管理者はワークスペース全体、それ以外は担当しているタスクとその配下、
// 招待で範囲が決まっている人はその範囲だけ。候補はボールの行がある未完了タスクだけなので件数は小さい
// (2026-10-05 本番で 136件) — LIMIT で切らずに全件返す。
export type MyTurnItem = {
  id: string; name: string; parent_name: string | null; deadline: string | null;
  state_updated_at: string | null; ball: string; direct: boolean;
};
export async function listMyTurn(
  viewer: { email: string; name: string | null }, wsId: string, opts: { admin: boolean; scopeGoalId: string | null }
): Promise<MyTurnItem[]> {
  const email = viewer.email.toLowerCase().trim();
  const m = await first<{ id: string; name: string | null }>("SELECT id, name FROM members WHERE email = ? AND workspace_id = ?", email, wsId);
  const keys = personKeys(m?.name || viewer.name || "");
  if (!keys.length) return [];
  const where: string[] = [
    "p.workspace_id = ?", "p.status NOT IN ('done', 'archived')", "p.archived_at IS NULL", "p.current_state LIKE '%ボール%'",
  ];
  const args: unknown[] = [wsId];
  // 再帰は `down CROSS JOIN projects` の順 (goalVisibilityClause のコメント参照。逆にすると全件走査になる)
  if (opts.scopeGoalId) {
    where.push(`p.id IN (WITH RECURSIVE down(id) AS (SELECT ? UNION SELECT c.id FROM down CROSS JOIN projects c ON c.parent_goal_id = down.id WHERE c.workspace_id = ?) SELECT id FROM down)`);
    args.push(opts.scopeGoalId, wsId);
  } else if (!opts.admin) {
    if (!m) return [];
    where.push(`p.id IN (WITH RECURSIVE down(id) AS (
        SELECT gm.goal_id FROM goal_members gm WHERE gm.member_id = ?
        UNION SELECT c.id FROM down CROSS JOIN projects c ON c.parent_goal_id = down.id WHERE c.workspace_id = ?) SELECT id FROM down)`);
    args.push(m.id, wsId);
  }
  const rows = await all<{ id: string; name: string; parent_name: string | null; deadline: string | null; state_updated_at: string | null; current_state: string }>(
    `SELECT p.id, p.name, par.name AS parent_name, p.deadline, p.state_updated_at, p.current_state
       FROM projects p LEFT JOIN projects par ON par.id = p.parent_goal_id
      WHERE ${where.join(" AND ")}`,
    ...args
  );
  const items: MyTurnItem[] = [];
  for (const r of rows) {
    const ball = ballText(r.current_state);
    if (!ball) continue;
    const rank = ballRank(ball, keys);
    if (!rank) continue;
    items.push({ id: r.id, name: r.name, parent_name: r.parent_name, deadline: r.deadline, state_updated_at: r.state_updated_at, ball, direct: rank === 1 });
  }
  // 期限があるものを期限順に先へ、残りは持ち主として書かれたもの → 現状が新しい順
  return items.sort((a, b) => {
    if (!!a.deadline !== !!b.deadline) return a.deadline ? -1 : 1;
    if (a.deadline && b.deadline && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
    if (a.direct !== b.direct) return a.direct ? -1 : 1;
    return (b.state_updated_at ?? "").localeCompare(a.state_updated_at ?? "");
  });
}

// 「終えたタスク」: 今日・今週 (月曜から) に誰が何件タスクを完了にしたか。メンバー全員が全員分の数を見られる
// (2026-10-05 黒崎の指示)。見せるのは数だけで、タスク名は本人の分だけ返す (担当外のタスクの中身は見せない)。
// 数え方: 完了にした人 (completed_by)。列ができる前 (0025 より前) の完了は担当者で数える。
// 親を完了にして一緒に閉じた配下 (親と5秒以内に閉じたもの) は、担当者で数えるときに除く。
function zonedStart(tz: string, kind: "day" | "week", now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false })
      .formatToParts(now).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const hh = Number(parts.hour) % 24, mm = Number(parts.minute), ss = Number(parts.second);
  // その時刻の UTC とのずれ (分)
  const offsetMs = Date.UTC(y, m - 1, d, hh, mm, ss) - Math.floor(now.getTime() / 1000) * 1000;
  let startLocal = Date.UTC(y, m - 1, d);
  if (kind === "week") {
    const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
    startLocal -= Math.max(0, wd) * 86400000;
  }
  return new Date(startLocal - offsetMs).toISOString();
}

export type DoneCount = { name: string; email: string; today: number; week: number };
export async function listDoneCounts(viewerEmail: string, wsId: string) {
  const ws = await first<{ timezone: string | null }>("SELECT timezone FROM workspaces WHERE id = ?", wsId);
  const tz = ws?.timezone?.trim() || "Asia/Tokyo";
  let dayStart: string, weekStart: string;
  try { dayStart = zonedStart(tz, "day"); weekStart = zonedStart(tz, "week"); }
  catch { dayStart = zonedStart("Asia/Tokyo", "day"); weekStart = zonedStart("Asia/Tokyo", "week"); }
  // 今週ぶんを1回で取り、今日かどうかは JS で分ける
  const rows = await all<{ who: string; completed_at: string }>(
    `SELECT lower(p.completed_by) AS who, p.completed_at
       FROM projects p
      WHERE p.workspace_id = ?1 AND p.status = 'done' AND p.completed_at >= ?2 AND p.completed_by IS NOT NULL
     UNION ALL
     SELECT lower(m.email) AS who, p.completed_at
       FROM projects p
       JOIN goal_members gm ON gm.goal_id = p.id
       JOIN members m ON m.id = gm.member_id AND m.workspace_id = ?1
       LEFT JOIN projects par ON par.id = p.parent_goal_id
      WHERE p.workspace_id = ?1 AND p.status = 'done' AND p.completed_at >= ?2 AND p.completed_by IS NULL
        AND NOT (par.completed_at IS NOT NULL AND abs(julianday(p.completed_at) - julianday(par.completed_at)) * 86400 < 5)`,
    wsId, weekStart
  );
  const roster = await all<{ name: string | null; email: string | null }>(
    "SELECT name, email FROM members WHERE workspace_id = ? AND email IS NOT NULL ORDER BY name", wsId
  );
  const counts = new Map<string, { today: number; week: number }>();
  for (const r of rows) {
    if (!r.who) continue;
    const c = counts.get(r.who) ?? { today: 0, week: 0 };
    c.week++;
    if (r.completed_at >= dayStart) c.today++;
    counts.set(r.who, c);
  }
  const members: DoneCount[] = roster.map((m) => {
    const email = (m.email ?? "").toLowerCase().trim();
    const c = counts.get(email) ?? { today: 0, week: 0 };
    return { name: m.name || email, email, ...c };
  }).sort((a, b) => b.today - a.today || b.week - a.week || a.name.localeCompare(b.name, "ja"));
  // 本人の分だけはタスク名も返す
  const me = viewerEmail.toLowerCase().trim();
  const mine = await all<{ id: string; name: string; completed_at: string }>(
    `SELECT p.id, p.name, p.completed_at FROM projects p
      WHERE p.workspace_id = ?1 AND p.status = 'done' AND p.completed_at >= ?2
        AND (lower(p.completed_by) = ?3 OR (p.completed_by IS NULL AND EXISTS (
              SELECT 1 FROM goal_members gm JOIN members m ON m.id = gm.member_id
               WHERE gm.goal_id = p.id AND m.workspace_id = ?1 AND lower(m.email) = ?3)
             AND NOT EXISTS (SELECT 1 FROM projects par WHERE par.id = p.parent_goal_id AND par.completed_at IS NOT NULL
                              AND abs(julianday(p.completed_at) - julianday(par.completed_at)) * 86400 < 5)))
      ORDER BY p.completed_at DESC`,
    wsId, dayStart, me
  );
  return { timezone: tz, dayStart, weekStart, members, mineToday: mine };
}
