import "server-only";
import { all, first, run, batch, uid, nowIso } from "./db";
import { queuePushToWorkspace, queuePushToMembers } from "./push";
import { notifyWorkspace } from "./realtime";
import { resolveMentionedMembers } from "./mentions";
import { ballRank, ballText, personKeys } from "../ball";

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
const GOAL_COLS = new Set(["name","emoji","deadline","current_state","completion_criteria","owner","status","archived_at","order_idx","parent_goal_id"]);
export async function updateGoal(id: string, patch: Record<string, unknown>, wsId: string) {
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

// ---------------- members ----------------
// Members are created only from real users (ensureMemberForUser) + invites —
// no seed step needed here (the one-time legacy-Addy cleanup this used to run
// on every single read finished long ago; forcing a DELETE on every read
// meant every members fetch paid for a write-path round-trip to D1's primary
// for nothing).
export async function listMembers(wsId: string) {
  return all("SELECT * FROM members WHERE workspace_id = ? ORDER BY is_you DESC, joined_at ASC", wsId);
}
export async function rankedMembers(wsId: string) {
  return all("SELECT * FROM members WHERE workspace_id = ? ORDER BY points DESC", wsId);
}
// Per-member assigned-goal progress (admin dashboard: who still has undone
// work). pending = assigned goals not yet done; done = assigned goals done;
// total = pending + done. A member with 0 assignments gets 0/0/0 — nothing to
// judge them on, not counted as "not doing tasks".
export async function memberTaskProgress(wsId: string) {
  return all<{ id: string; name: string; avatar: string | null; is_you: number; pending: number; done: number; total: number }>(
    `SELECT m.id, m.name, m.avatar, m.is_you,
            COALESCE(SUM(CASE WHEN p.status NOT IN ('done','archived') THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN p.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
            COALESCE(SUM(CASE WHEN p.status != 'archived' THEN 1 ELSE 0 END), 0) AS total
       FROM members m
       LEFT JOIN goal_members gm ON gm.member_id = m.id
       LEFT JOIN projects p ON p.id = gm.goal_id AND p.workspace_id = m.workspace_id
      WHERE m.workspace_id = ? AND m.is_ai = 0
      GROUP BY m.id
      ORDER BY pending DESC, m.joined_at ASC`,
    wsId
  );
}
export async function inviteMember(name: string, wsId: string, email?: string) {
  const id = uid();
  await run("INSERT INTO members (id, name, email, role, workspace_id) VALUES (?,?,?, 'None', ?)", id, name.trim(), email?.trim() ?? null, wsId);
  await createNotification({ kind: "mention", title: "メンバーを招待", body: `${name.trim()} を招待しました` }, wsId);
  return first("SELECT * FROM members WHERE id = ?", id);
}

// ---------------- usage / api key (settings) ----------------
export async function usageStats(wsId: string) {
  const [goals, tasks, doneTasks, addy, notifs] = await Promise.all([
    first<{ c: number }>("SELECT COUNT(*) AS c FROM projects WHERE status != 'archived' AND workspace_id = ?", wsId),
    first<{ c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE workspace_id = ?", wsId),
    first<{ c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE completed_at IS NOT NULL AND workspace_id = ?", wsId),
    first<{ c: number }>("SELECT COUNT(*) AS c FROM chat_messages WHERE role = 'addy' AND workspace_id = ?", wsId),
    first<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE workspace_id = ?", wsId),
  ]);
  const aiRequests = addy?.c ?? 0;
  return {
    aiRequests,
    aiLimit: 1000,
    goals: goals?.c ?? 0,
    tasks: tasks?.c ?? 0,
    doneTasks: doneTasks?.c ?? 0,
    notifications: notifs?.c ?? 0,
  };
}

function genApiKey(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `addn_${hex}`;
}
export async function getApiKey(wsId: string): Promise<string> {
  const row = await first<{ mcp_token: string | null }>("SELECT mcp_token FROM workspaces WHERE id = ?", wsId);
  if (row?.mcp_token) return row.mcp_token;
  const k = genApiKey();
  await run("UPDATE workspaces SET mcp_token = ? WHERE id = ?", k, wsId);
  return k;
}
export async function regenApiKey(wsId: string): Promise<string> {
  const k = genApiKey();
  await run("UPDATE workspaces SET mcp_token = ? WHERE id = ?", k, wsId);
  return k;
}
// Per-member key: lets a (possibly goal-scoped) member connect their own AI.
// The MCP worker resolves it to this membership and enforces the same scope.
export async function getMemberApiKey(wsId: string, userId: string): Promise<string> {
  const row = await first<{ mcp_token: string | null }>(
    "SELECT mcp_token FROM workspace_members WHERE workspace_id = ? AND user_id = ?", wsId, userId
  );
  if (row?.mcp_token) return row.mcp_token;
  const k = genApiKey();
  await run("UPDATE workspace_members SET mcp_token = ? WHERE workspace_id = ? AND user_id = ?", k, wsId, userId);
  return k;
}
export async function regenMemberApiKey(wsId: string, userId: string): Promise<string> {
  const k = genApiKey();
  await run("UPDATE workspace_members SET mcp_token = ? WHERE workspace_id = ? AND user_id = ?", k, wsId, userId);
  return k;
}
const MEMBER_COLS = new Set(["name","role","email","avatar","points","streak"]);
export async function updateMember(id: string, patch: Record<string, unknown>, wsId: string) {
  const keys = Object.keys(patch).filter((k) => MEMBER_COLS.has(k));
  if (!keys.length) return;
  await run(`UPDATE members SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND workspace_id = ?`, ...keys.map((k) => patch[k]), id, wsId);
}
export async function removeMember(id: string, wsId: string) {
  // members is just the display roster (keyed by email, no user_id) — the
  // real access grant is workspace_members(workspace_id, user_id). Deleting
  // only the roster row left removed people able to log back in with full
  // access (and their mcp_token, which lives on workspace_members, alive).
  const m = await first<{ email: string | null }>("SELECT email FROM members WHERE id = ? AND workspace_id = ?", id, wsId);
  if (m?.email) {
    const email = m.email.toLowerCase().trim();
    await run(
      `DELETE FROM workspace_members WHERE workspace_id = ? AND user_id IN (SELECT id FROM users WHERE lower(email) = ?)`,
      wsId, email
    );
    // also drop any still-live invite for this address so the same link can't
    // silently re-enroll them.
    await run("DELETE FROM invites WHERE workspace_id = ? AND lower(email) = ?", wsId, email);
  }
  await run("DELETE FROM members WHERE id = ? AND is_you = 0 AND workspace_id = ?", id, wsId);
}
export async function addPoints(delta: number) {
  await run("UPDATE members SET points = points + ? WHERE is_you = 1", delta);
}

// ---------------- notifications ----------------
// Goal ids relevant to a member for notification purposes: their own assigned
// goals plus everything under them (assignment propagates DOWN — same rule
// canEditGoal/pruneToAssigned already use: assign the parent, cover the
// children). null = no roster member found; [] = member exists but has no
// assignments at all (sees only goal-less/org-level notifications).
export async function memberRelevantGoalIds(email: string, wsId: string): Promise<string[] | null> {
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", email.toLowerCase().trim(), wsId);
  if (!m) return null;
  const roots = await all<{ goal_id: string }>("SELECT goal_id FROM goal_members WHERE member_id = ?", m.id);
  if (!roots.length) return [];
  // walk down from the member's assignments inside SQL — passing every root id
  // as a bound parameter blows D1's per-query parameter cap once someone holds
  // more than ~100 assignments.
  // UNION (not UNION ALL): a member assigned to both a goal and its subtasks
  // walked the same subtree once per assignment — 3,370万行・15秒 on the real
  // DB, which stalled every other query (login included) behind it.
  const rows = await all<{ id: string }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT p.id FROM projects p JOIN goal_members gm ON gm.goal_id = p.id
        WHERE gm.member_id = ? AND p.workspace_id = ?
       UNION
       SELECT p.id FROM sub CROSS JOIN projects p ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?
     )
     SELECT id FROM sub`,
    m.id, wsId, wsId
  );
  return rows.map((r) => r.id);
}
// The members who should be notified/pushed about an event at goalId: the
// people assigned to that goal. If nobody is assigned to it, the event falls
// up to the NEAREST ancestor that has assignees — an unassigned subtask still
// reaches whoever owns that branch, and stops there.
//
// It used to collect every ancestor's assignees at once. With top-level goals
// assigned to the owner that meant "assigned to a root" = "notified about
// everything in the company", which is what turned this into a notification
// firehose. アサインされている人以外には通知は行かない。
export async function goalNotificationRecipientEmails(goalId: string, wsId: string): Promise<string[]> {
  // アサインされている人には必ず届く — そのタスク本体の担当者と、親から根までの
  // 担当者の全員。以前は最初にアサインが見つかった段で打ち切っていたため、
  // 子タスクに担当が付いた瞬間から親の担当者(自分の顧客ゴールなど)へ通知が
  // 飛ばなくなっていた (2026-09-09 黒崎指摘)。
  const emails = new Set<string>();
  let cur: string | null = goalId;
  let guard = 0;
  while (cur && guard < 30) {
    guard += 1;
    const rows = await all<{ email: string | null }>(
      `SELECT DISTINCT m.email FROM goal_members gm JOIN members m ON m.id = gm.member_id
        WHERE gm.goal_id = ? AND m.workspace_id = ?`,
      cur, wsId
    );
    for (const r of rows) if (r.email) emails.add(r.email.toLowerCase().trim());
    const parentRow: { parent_goal_id: string | null } | null = await first(
      "SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?", cur, wsId
    );
    cur = parentRow?.parent_goal_id ?? null;
  }
  return [...emails];
}
// viewerEmail omitted/null = admin view, unfiltered (admins see everything —
// they need full oversight). Otherwise scoped to memberRelevantGoalIds plus
// goal-less (org-level) notifications, so unassigned members stop getting
// pinged for tasks that have nothing to do with them.
// goal-based visibility clause shared by listNotifications/unreadCount, plus
// its bind args. A row with target_email set (an @mention) is carved out of
// this broadcast rule entirely — only the mentioned person sees it (added by
// the caller as a separate `OR target_email = ?` branch), even if the viewer
// would otherwise qualify via goal assignment.
// The id list is resolved inside SQL rather than bound one id per parameter —
// a member with a large assigned subtree used to push the query past D1's
// bound parameter cap, which made the whole notification list fail.
//
// Two ways a goal-linked row qualifies:
//   1. it was addressed to the viewer when it was sent (notification_recipients
//      — a snapshot, so unassigning someone or moving a task later doesn't
//      retroactively delete notifications they already received). This is the
//      rule for everything sent since migration 0016.
//   2. legacy rows only (no recipient snapshot at all): it hangs off a goal in
//      the viewer's assigned subtree.
// An ancestor branch used to be ORed in here too (notifications from goals
// ABOVE an assignment), and the subtree branch used to apply to every row. Both
// pinged people about work they aren't assigned to — with the top-level goals
// assigned to the owner, that meant everyone under a root heard everything.
// アサインされている人以外に通知は行かない。
async function goalVisibilityClause(viewerEmail: string, wsId: string): Promise<{ clause: string; args: string[] }> {
  const email = viewerEmail.toLowerCase().trim();
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", email, wsId);
  if (!m) return { clause: "goal_id IS NULL", args: [] };
  // 再帰の各段は `down CROSS JOIN projects` の順で書く。`projects JOIN down` だと
  // SQLite が projects 側を workspace_id で全件走査し、1段ごとに全タスクを読む
  // (バッジの件数1回で129万行・0.7秒。15秒ごとに叩かれて D1 が詰まり、ログインまで止まった)。
  // CROSS JOIN は結合順を固定するので、parent_goal_id のインデックスで子だけを引く。
  const clause =
    `(goal_id IS NULL
      OR EXISTS (SELECT 1 FROM notification_recipients nrc WHERE nrc.notification_id = n.id AND nrc.email = ?)
      OR (NOT EXISTS (SELECT 1 FROM notification_recipients nra WHERE nra.notification_id = n.id)
      AND goal_id IN (
        WITH RECURSIVE
          down(id) AS (
            SELECT p.id FROM projects p JOIN goal_members gm ON gm.goal_id = p.id
             WHERE gm.member_id = ? AND p.workspace_id = ?
            UNION
            SELECT p.id FROM down CROSS JOIN projects p ON p.parent_goal_id = down.id WHERE p.workspace_id = ?
          )
        SELECT id FROM down)))`;
  return { clause, args: [email, m.id, wsId, wsId] };
}
// 既読はユーザー単位 (notification_reads)。notifications.read_at は旧・全員共有
// 既読の名残で、値が入っている行は「全員既読」として扱い、以後は書かない。
// クライアントには従来通り read_at として見せる(未読なら NULL)ので表示側は無変更。
export type NotifViewer = { email: string; admin: boolean };
const NOTIF_COLS =
  "n.id, n.kind, n.title, n.body, n.goal_id, n.workspace_id, n.target_email, n.created_at, COALESCE(n.read_at, nr.read_at) AS read_at";
const NOTIF_READ_JOIN = "LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.email = ?";
// ページング必須。以前は LIMIT 100 固定で打ち切っていたので、通知が100件を
// 超えたメンバーは古いものが一覧から丸ごと消えていた (実測: 一部メンバーで
// 130件以上が到達不能)。1件多く取って hasMore を返す。
export const NOTIF_PAGE_SIZE = 50;
export async function listNotifications(filter: "all" | "unread", wsId: string, viewer: NotifViewer, offset = 0) {
  const email = viewer.email.toLowerCase().trim();
  const readClause = filter === "unread" ? "n.read_at IS NULL AND nr.notification_id IS NULL AND " : "";
  const page = NOTIF_PAGE_SIZE;
  const rows = viewer.admin
    ? await all(
        `SELECT ${NOTIF_COLS} FROM notifications n ${NOTIF_READ_JOIN} WHERE ${readClause}n.workspace_id = ? ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
        email, wsId, page + 1, offset
      )
    : await (async () => {
        const { clause, args } = await goalVisibilityClause(viewer.email, wsId);
        return all(
          `SELECT ${NOTIF_COLS} FROM notifications n ${NOTIF_READ_JOIN} WHERE ${readClause}n.workspace_id = ? AND ((n.target_email IS NULL AND ${clause}) OR n.target_email = ?) ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
          email, wsId, ...args, email, page + 1, offset
        );
      })();
  const hasMore = rows.length > page;
  return { items: hasMore ? rows.slice(0, page) : rows, hasMore, offset };
}
// ベルのバッジは「まだ見ていないお知らせの数」であって「未読の数」ではない。
// 通知ページを開いたら消えてほしいが、開いただけで全部を既読にすると何が新着
// だったのか分からなくなる (それが元の挙動だった)。開いた時刻を notification_seen
// に記録し、バッジはそれより後に届いた未読だけを数える。一覧側の未読マークは
// read_at ベースのままなので、開くだけでは消えない。
export async function markNotificationsSeen(wsId: string, viewerEmail: string) {
  const email = viewerEmail.toLowerCase().trim();
  await run(
    `INSERT INTO notification_seen (email, workspace_id, seen_at) VALUES (?,?,?)
       ON CONFLICT(email, workspace_id) DO UPDATE SET seen_at = excluded.seen_at`,
    email, wsId, nowIso()
  );
}
const NOTIF_SEEN_CLAUSE =
  "n.created_at > COALESCE((SELECT seen_at FROM notification_seen WHERE email = ? AND workspace_id = ?), '')";
// バッジは「自分に来たお知らせ」の数。管理者も同じ扱いにする — 一覧では全件
// 見えるままだが (オーナーの監督用)、他人宛ての通知でベルが鳴るのは通知洪水の
// もとで、そのせいで自分宛てのメンションが埋もれていた。
export async function unreadCount(wsId: string, viewer: NotifViewer) {
  const email = viewer.email.toLowerCase().trim();
  const { clause, args } = await goalVisibilityClause(viewer.email, wsId);
  const r = await first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM notifications n ${NOTIF_READ_JOIN} WHERE n.read_at IS NULL AND nr.notification_id IS NULL AND ${NOTIF_SEEN_CLAUSE} AND n.workspace_id = ? AND ((n.target_email IS NULL AND ${clause}) OR n.target_email = ?)`,
    email, email, wsId, wsId, ...args, email
  );
  return r?.c ?? 0;
}
export async function markRead(id: string, wsId: string, viewerEmail: string) {
  await run(
    "INSERT OR IGNORE INTO notification_reads (notification_id, email, read_at) SELECT id, ?, ? FROM notifications WHERE id = ? AND workspace_id = ?",
    viewerEmail.toLowerCase().trim(), nowIso(), id, wsId
  );
}
export async function markAllRead(wsId: string, viewer: NotifViewer) {
  const email = viewer.email.toLowerCase().trim();
  let where = "n.workspace_id = ?";
  const args: string[] = [wsId];
  if (!viewer.admin) {
    const v = await goalVisibilityClause(viewer.email, wsId);
    where += ` AND ((n.target_email IS NULL AND ${v.clause}) OR n.target_email = ?)`;
    args.push(...v.args, email);
  }
  await run(
    `INSERT OR IGNORE INTO notification_reads (notification_id, email, read_at) SELECT n.id, ?, ? FROM notifications n WHERE n.read_at IS NULL AND ${where}`,
    email, nowIso(), ...args
  );
}
// Who this notification went out to, frozen at send time. Chunked for the same
// reason every other IN(...) here is: D1 caps bound parameters per query.
async function recordNotificationRecipients(notificationId: string, emails: string[]) {
  const uniq = [...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
  if (!uniq.length) return;
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    await run(
      `INSERT OR IGNORE INTO notification_recipients (notification_id, email) VALUES ${chunk.map(() => "(?,?)").join(",")}`,
      ...chunk.flatMap((e) => [notificationId, e])
    );
  }
}
// Notifications carry a workspace_id. When the notification is tied to a goal we
// derive the workspace from that goal (works for internal callers that only know
// the goal); otherwise the caller passes the active workspace explicitly.
export async function createNotification(n: { kind?: string; title: string; body?: string | null; goal_id?: string | null; targetEmail?: string | null }, wsId?: string) {
  let workspaceId = wsId ?? "default";
  if (n.goal_id) {
    const g = await first<{ workspace_id: string }>("SELECT workspace_id FROM projects WHERE id = ?", n.goal_id);
    workspaceId = g?.workspace_id ?? wsId ?? "default";
  }
  const targetEmail = n.targetEmail?.toLowerCase().trim() || null;
  const id = uid();
  await run(
    "INSERT INTO notifications (id, kind, title, body, goal_id, workspace_id, target_email) VALUES (?,?,?,?,?,?,?)",
    id, n.kind ?? "info", n.title, n.body ?? null, n.goal_id ?? null, workspaceId, targetEmail
  );
  // push to phones for completion / big-goal / assignment / mention events.
  // A targeted notification (@mention) only wakes that one person. Goal-linked
  // untargeted events wake the people connected to that goal (its assignees +
  // any ancestor's assignees), not the whole workspace. Goal-less (org-level)
  // events still go to everyone.
  const kind = n.kind ?? "info";
  // Encrypted payload so the lock screen shows the real content even when the
  // device's app session has expired (no more fixed 「新しい通知があります」).
  const payload = { title: n.title, body: n.body ?? null, url: n.goal_id ? `/goals/${n.goal_id}` : "/notifications" };
  const pushable = kind === "goal" || kind === "streak" || kind === "mention" || kind === "info";
  if (targetEmail) {
    await recordNotificationRecipients(id, [targetEmail]);
    queuePushToMembers(workspaceId, [targetEmail], payload);
  } else if (n.goal_id) {
    // Freeze the audience now. The list query still falls back to the live
    // assignment tree for older rows, but from here on a notification stays
    // visible to whoever it was sent to even if assignments change later.
    const emails = await goalNotificationRecipientEmails(n.goal_id, workspaceId);
    await recordNotificationRecipients(id, emails);
    if (pushable) queuePushToMembers(workspaceId, emails, payload);
  } else if (pushable) {
    // goal-less = workspace-wide; visible to everyone via `goal_id IS NULL`,
    // so there's nothing worth snapshotting.
    queuePushToWorkspace(workspaceId, payload);
  }
  // realtime: nudge connected devices to refetch
  notifyWorkspace(workspaceId);
}

// ---------------- goal page bundle (one request per page transition) ----------------
// The goal detail page used to fire 2 requests per child (progress + assignees)
// on top of 6 base requests. This returns everything the page needs in one shot.
export async function goalBundle(id: string, wsId: string) {
  const goal = await getGoal(id, wsId);
  if (!goal) return null;
  const [ancestors, children, resources, comments, assignees] = await Promise.all([
    getAncestors(id, wsId),
    listChildren(id, wsId),
    listResources(id, wsId),
    listMessages(id, wsId),
    listGoalMembers(id, wsId),
  ]);
  const ids = (children as { id: string }[]).map((c) => c.id);
  const childProgress: Record<string, { done: number; total: number }> = {};
  const childAssignees: Record<string, unknown[]> = {};
  if (ids.length) {
    const progChunks: { pid: string; done: number; total: number }[][] = [];
    const [, byGoal] = await Promise.all([
      (async () => {
        // chunked for the same reason as listGoalMembersBatch — D1 bound params
        for (let i = 0; i < ids.length; i += GOAL_ID_CHUNK) {
          const chunk = ids.slice(i, i + GOAL_ID_CHUNK);
          const ph = chunk.map(() => "?").join(",");
          progChunks.push(await all<{ pid: string; done: number; total: number }>(
            `SELECT parent_goal_id AS pid,
                    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                    COUNT(*) AS total
               FROM projects
              WHERE parent_goal_id IN (${ph}) AND status != 'archived' AND workspace_id = ?
              GROUP BY parent_goal_id`,
            ...chunk, wsId
          ));
        }
      })(),
      listGoalMembersBatch(ids, wsId),
    ]);
    for (const cid of ids) { childProgress[cid] = { done: 0, total: 0 }; childAssignees[cid] = []; }
    for (const rows of progChunks) for (const r of rows) childProgress[r.pid] = { done: r.done, total: r.total };
    for (const [cid, ms] of Object.entries(byGoal)) childAssignees[cid] = ms;
  }
  return { goal, ancestors, children, resources, comments, assignees, childProgress, childAssignees };
}

// ---------------- chat ----------------
export async function listMessages(goalId: string, wsId: string) {
  return all("SELECT * FROM chat_messages WHERE goal_id = ? AND workspace_id = ? ORDER BY created_at ASC", goalId, wsId);
}
export async function messageCount(goalId: string, wsId: string) {
  const r = await first<{ c: number }>("SELECT COUNT(*) AS c FROM chat_messages WHERE goal_id = ? AND workspace_id = ?", goalId, wsId);
  return r?.c ?? 0;
}
// @name mentions in a comment resolve against every workspace member — not
// just the goal's assignees, so mentioning someone who isn't assigned still
// notifies them (longest name first, so "黒崎優斗" isn't shadowed by a shorter
// coincidental prefix match like "黒崎"). Only mentioned people get notified —
// comments no longer broadcast a notification to everyone with goal access.
async function resolveMentions(wsId: string, body: string) {
  const members = await listMembers(wsId) as { id: string; name: string; email: string | null }[];
  return resolveMentionedMembers(body, members);
}
export async function sendMessage(goalId: string, body: string, wsId: string, role = "user", author = "メンバー", authorEmail: string | null = null) {
  const id = uid();
  await run(
    "INSERT INTO chat_messages (id, goal_id, role, author, author_email, body, workspace_id) VALUES (?,?,?,?,?,?,?)",
    id, goalId, role, author, authorEmail?.toLowerCase().trim() || null, body, wsId
  );
  const mentioned = await resolveMentions(wsId, body);
  const me = authorEmail?.toLowerCase().trim() || null;
  const mentionedEmails = new Set(
    mentioned.map((m) => m.email?.toLowerCase().trim()).filter((e): e is string => !!e)
  );
  const g = await first<{ name: string }>("SELECT name FROM projects WHERE id = ?", goalId);
  for (const email of mentionedEmails) {
    await createNotification(
      { kind: "mention", title: `${author}さんからメンション`, body: `「${g?.name ?? "タスク"}」: ${body}`, goal_id: goalId, targetEmail: email },
      wsId
    );
  }
  // メンションが無いコメントも、そのタスク(と上位ゴール)の担当者には届かせる。
  // 「アサインされている場所の動きは必ず通知」の一部 (2026-09-09 黒崎指示)。
  // 1人ずつ targetEmail で出すので、メンションと同じく本人にだけ届く。
  const watchers = await goalNotificationRecipientEmails(goalId, wsId);
  for (const email of watchers) {
    if (mentionedEmails.has(email)) continue; // メンション通知で既に届いている
    if (me && email === me) continue; // 自分のコメントで自分を鳴らさない
    await createNotification(
      { kind: "info", title: `${author}さんがコメント`, body: `「${g?.name ?? "タスク"}」: ${body}`, goal_id: goalId, targetEmail: email },
      wsId
    );
  }
  return first("SELECT * FROM chat_messages WHERE id = ?", id);
}
export async function getMessage(id: string, wsId: string) {
  return first<{ id: string; goal_id: string | null; author: string | null; author_email: string | null; body: string }>(
    "SELECT * FROM chat_messages WHERE id = ? AND workspace_id = ?", id, wsId
  );
}
export async function updateMessage(id: string, body: string, wsId: string) {
  await run("UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ? AND workspace_id = ?", body, nowIso(), id, wsId);
  return first("SELECT * FROM chat_messages WHERE id = ?", id);
}
export async function deleteMessage(id: string, wsId: string) {
  await run("DELETE FROM chat_messages WHERE id = ? AND workspace_id = ?", id, wsId);
}

// ---------------- resources ----------------
export async function listResources(goalId: string, wsId: string) {
  return all("SELECT * FROM resources WHERE goal_id = ? AND workspace_id = ? ORDER BY updated_at DESC", goalId, wsId);
}
export async function createResource(goalId: string, name: string, wsId: string, kind = "note", content: string | null = null, url: string | null = null) {
  const id = uid();
  await run(
    "INSERT INTO resources (id, goal_id, name, kind, content, url, workspace_id) VALUES (?,?,?,?,?,?,?)",
    id, goalId, name.trim() || "無題", kind, content, url, wsId
  );
  return first("SELECT * FROM resources WHERE id = ?", id);
}
const RESOURCE_COLS = new Set(["name", "kind", "content", "url"]);
export async function updateResource(id: string, patch: Record<string, unknown>, wsId: string) {
  const keys = Object.keys(patch).filter((k) => RESOURCE_COLS.has(k));
  if (!keys.length) return;
  await run(
    `UPDATE resources SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    ...keys.map((k) => patch[k]), nowIso(), id, wsId
  );
}
export async function deleteResource(id: string, wsId: string) {
  await run("DELETE FROM resources WHERE id = ? AND workspace_id = ?", id, wsId);
}

// ---------------- org settings (now the active workspace) ----------------
export async function getOrgSettings(wsId: string) {
  return (await first("SELECT id, name, timezone, logo_url FROM workspaces WHERE id = ?", wsId)) ?? { id: wsId, name: "マイワークスペース", timezone: "Asia/Tokyo", logo_url: null };
}
export async function updateOrgSettings(patch: Record<string, unknown>, wsId: string) {
  const cols = ["name", "timezone", "logo_url"].filter((k) => k in patch);
  if (!cols.length) return;
  await run(`UPDATE workspaces SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...cols.map((k) => patch[k]), wsId);
}

// ---------------- streak / done_log ----------------
export async function recentDone(wsId: string, limit = 30) {
  return all("SELECT * FROM done_log WHERE workspace_id = ? ORDER BY completed_at DESC LIMIT ?", wsId, limit);
}
export async function computeStreak(wsId: string) {
  const dates = new Set<string>();
  const [dl, nd] = await Promise.all([
    // Both capped at 400 rows, so both must take the NEWEST 400 — the nodes
    // query had no ORDER BY, which handed back an arbitrary slice and made the
    // streak silently wrong once the workspace had more than 400 done nodes.
    all<{ completed_at: string }>("SELECT completed_at FROM done_log WHERE workspace_id = ? ORDER BY completed_at DESC LIMIT 400", wsId),
    all<{ completed_at: string | null }>("SELECT completed_at FROM nodes WHERE completed_at IS NOT NULL AND workspace_id = ? ORDER BY completed_at DESC LIMIT 400", wsId),
  ]);
  const push = (iso: string | null) => { if (iso) dates.add(new Date(iso).toISOString().slice(0, 10)); };
  dl.forEach((r) => push(r.completed_at));
  nd.forEach((r) => push(r.completed_at));
  let streak = 0;
  const cur = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  if (!dates.has(fmt(cur))) cur.setDate(cur.getDate() - 1);
  while (dates.has(fmt(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
  return streak;
}

// ---------------- invites ----------------
export async function createInvite(opts: { email?: string | null; role?: string; createdBy?: string; workspaceId: string; goalId?: string | null }) {
  const token = uid();
  const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
  await run(
    "INSERT INTO invites (token, email, role, created_by, expires_at, workspace_id, goal_id) VALUES (?,?,?,?,?,?,?)",
    token, opts.email?.trim() || null, opts.role === "admin" ? "admin" : "member", opts.createdBy ?? null, expires, opts.workspaceId, opts.goalId ?? null
  );
  return first("SELECT * FROM invites WHERE token = ?", token);
}
export async function listInvites(workspaceId: string) {
  const nowIsoStr = nowIso();
  // Links are multi-use: accepted ones stay live (and listed) until they
  // expire or an admin revokes them.
  return all(
    "SELECT * FROM invites WHERE workspace_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC",
    workspaceId, nowIsoStr
  );
}
export async function revokeInvite(token: string, wsId: string) {
  await run("DELETE FROM invites WHERE token = ? AND workspace_id = ?", token, wsId);
}
export type InviteRow = { token: string; email: string | null; role: string; accepted_at: string | null; expires_at: string | null; workspace_id: string; goal_id: string | null };
// Raw row regardless of validity — lets callers distinguish used/expired/unknown.
export async function getInvite(token: string) {
  return first<InviteRow>(
    "SELECT token, email, role, accepted_at, expires_at, workspace_id, goal_id FROM invites WHERE token = ?",
    token
  );
}
// Multi-use: acceptance does NOT consume the link — it stays valid until it
// expires or is revoked. accepted_at/accepted_user_id only record the latest
// join for audit.
export async function getValidInvite(token: string) {
  const row = await getInvite(token);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}
export async function acceptInvite(token: string, userId: string) {
  await run("UPDATE invites SET accepted_at = ?, accepted_user_id = ? WHERE token = ?", nowIso(), userId, token);
}

// ---------------- goal members (assignment + per-goal edit permission) ----------------
export async function listGoalMembers(goalId: string, wsId: string) {
  return all(
    `SELECT m.id, m.name, m.email, m.avatar, m.is_you, gm.can_edit
     FROM goal_members gm JOIN members m ON m.id = gm.member_id
     WHERE gm.goal_id = ? AND m.workspace_id = ? ORDER BY gm.assigned_at ASC`,
    goalId, wsId
  );
}

// How many goal ids go into a single IN (...) — kept well under D1's bound
// parameter cap so one oversized page never wipes out the whole result.
const GOAL_ID_CHUNK = 50;

// Same shape as listGoalMembers but for every goal in one round trip — the
// main tasks page used to fire one request per visible goal (N+1, and it
// re-runs on every 15s/realtime refresh) just to paint assignee avatars.
type MemberRow = { goal_id: string; id: string; name: string; email: string | null; avatar: string | null; is_you: number; can_edit: number };
// Avatars live in D1 as base64 data URLs (up to ~40KB each). Selecting them per
// assignment row pulled ~10MB out of D1 for one tree load; hand out a small
// cacheable URL (/api/members/:id/avatar) straight from SQL instead.
const MEMBER_COLS_SQL = `gm.goal_id, m.id, m.name, m.email,
         CASE WHEN m.avatar LIKE 'data:%' THEN '/api/members/' || m.id || '/avatar' ELSE m.avatar END AS avatar,
         m.is_you, gm.can_edit`;
// Every assignment on a non-archived goal of the workspace in ONE query (the
// tree used to fetch these in 40〜50 sequential chunks of 50 ids).
export async function listGoalMembersAll(wsId: string, scopeGoalId: string | null = null): Promise<Record<string, Omit<MemberRow, "goal_id">[]>> {
  const rows = await all<MemberRow>(
    `SELECT ${MEMBER_COLS_SQL}
       FROM goal_members gm
       JOIN members m ON m.id = gm.member_id
       JOIN projects p ON p.id = gm.goal_id
      WHERE p.workspace_id = ? AND p.status != 'archived' AND m.workspace_id = ?
      ORDER BY gm.assigned_at ASC`,
    wsId, wsId
  );
  let allowed: Set<string> | null = null;
  if (scopeGoalId) allowed = new Set(((await listGoals(wsId, scopeGoalId)) as { id: string }[]).map((g) => g.id));
  const result: Record<string, Omit<MemberRow, "goal_id">[]> = {};
  for (const r of rows) {
    if (allowed && !allowed.has(r.goal_id)) continue;
    const { goal_id, ...m } = r;
    (result[goal_id] ??= []).push(m);
  }
  return result;
}
export async function listGoalMembersBatch(goalIds: string[], wsId: string): Promise<Record<string, Omit<MemberRow, "goal_id">[]>> {
  const result: Record<string, Omit<MemberRow, "goal_id">[]> = {};
  for (const id of goalIds) result[id] = [];
  if (!goalIds.length) return result;
  if (goalIds.length > GOAL_ID_CHUNK) {
    // bigger than one chunk: fetch everything once and pick the requested ids
    const everything = await listGoalMembersAll(wsId);
    for (const id of goalIds) if (everything[id]) result[id] = everything[id];
    return result;
  }
  // D1 caps bound parameters per query, so a long id list can't go in one IN().
  const ph = goalIds.map(() => "?").join(",");
  const rows = await all<MemberRow>(
    `SELECT ${MEMBER_COLS_SQL}
       FROM goal_members gm JOIN members m ON m.id = gm.member_id
      WHERE gm.goal_id IN (${ph}) AND m.workspace_id = ?
      ORDER BY gm.assigned_at ASC`,
    ...goalIds, wsId
  );
  for (const r of rows) { const { goal_id, ...m } = r; result[goal_id].push(m); }
  return result;
}
export async function getMemberAvatar(id: string, wsId: string): Promise<string | null> {
  const r = await first<{ avatar: string | null }>("SELECT avatar FROM members WHERE id = ? AND workspace_id = ?", id, wsId);
  return r?.avatar ?? null;
}
export async function assignGoalMember(goalId: string, memberId: string, canEdit = false, notify = false) {
  await run(
    "INSERT OR IGNORE INTO goal_members (goal_id, member_id, can_edit) VALUES (?,?,?)",
    goalId, memberId, canEdit ? 1 : 0
  );
  if (notify) {
    const m = await first<{ name: string }>("SELECT name FROM members WHERE id = ?", memberId);
    const g = await first<{ name: string }>("SELECT name FROM projects WHERE id = ?", goalId);
    await createNotification({ kind: "mention", title: "アサインされました", body: `${m?.name ?? "メンバー"} が「${g?.name ?? "タスク"}」にアサインされました`, goal_id: goalId });
  }
}
export async function unassignGoalMember(goalId: string, memberId: string) {
  await run("DELETE FROM goal_members WHERE goal_id = ? AND member_id = ?", goalId, memberId);
}
export async function setGoalMemberEdit(goalId: string, memberId: string, canEdit: boolean) {
  await run("UPDATE goal_members SET can_edit = ? WHERE goal_id = ? AND member_id = ?", canEdit ? 1 : 0, goalId, memberId);
}
// Goals/tasks a member is assigned to (for the member detail "配属" view).
export async function listMemberGoals(memberId: string, wsId: string) {
  return all(
    `SELECT p.id, p.name, p.emoji, p.status, p.parent_goal_id, gm.can_edit
     FROM goal_members gm JOIN projects p ON p.id = gm.goal_id
     WHERE gm.member_id = ? AND p.status != 'archived' AND p.workspace_id = ?
     ORDER BY p.name ASC`,
    memberId, wsId
  );
}
export async function setGoalCreator(goalId: string, userId: string, wsId: string) {
  await run("UPDATE projects SET created_by = ? WHERE id = ? AND created_by IS NULL AND workspace_id = ?", userId, goalId, wsId);
}

// The creator automatically becomes the goal's manager + holder (assigned, can edit).
export async function assignCreatorAsHolder(goalId: string, user: { id: string; email: string; name: string | null; role: string }, wsId: string) {
  await ensureMemberForUser(user, wsId);
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", user.email.toLowerCase().trim(), wsId);
  if (m) await assignGoalMember(goalId, m.id, true);
}

// 人のセッションが無い経路 (サーバー間の API 呼び出しなど) で作られた
// タスクの持ち主。ワークスペースの持ち主に付ける。
// workspaces.created_by、無ければ workspace_members の admin のうち最古参。
export async function assignWorkspaceOwnerAsHolder(goalId: string, wsId: string) {
  const owner =
    (await first<{ id: string; name: string | null; email: string }>(
      `SELECT u.id, u.name, u.email FROM workspaces w JOIN users u ON u.id = w.created_by
        WHERE w.id = ? AND u.email IS NOT NULL`,
      wsId
    )) ??
    (await first<{ id: string; name: string | null; email: string }>(
      `SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND wm.role = 'admin' AND u.email IS NOT NULL
        ORDER BY wm.joined_at ASC LIMIT 1`,
      wsId
    ));
  if (!owner) return;
  await setGoalCreator(goalId, owner.id, wsId);
  await assignCreatorAsHolder(goalId, { id: owner.id, email: owner.email, name: owner.name, role: "admin" }, wsId);
}

// Anyone who touches a goal (edits it, comments on it, checks a task off)
// gets assigned to it automatically — 関わった人 = 担当者. This keeps
// 自分のタスク honest without anyone having to remember to self-assign.
// Silent (no アサインされました notification) and idempotent; skipped if the
// user or an ancestor is already assigned so parents don't accumulate
// duplicate child assignments.
export async function assignOnTouch(user: { id: string; email: string; name: string | null; role: string }, goalId: string, wsId: string) {
  try {
    await ensureMemberForUser(user, wsId);
    const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", user.email.toLowerCase().trim(), wsId);
    if (!m) return;
    // already assigned here or on an ancestor? then nothing to do
    let cur: string | null = goalId;
    let guard = 0;
    while (cur && guard++ < 30) {
      const gm = await first("SELECT 1 AS x FROM goal_members WHERE goal_id = ? AND member_id = ?", cur, m.id);
      if (gm) return;
      const node: { parent_goal_id: string | null } | null = await first("SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?", cur, wsId);
      if (!node) break;
      cur = node.parent_goal_id;
    }
    await assignGoalMember(goalId, m.id, true);
  } catch {
    /* assignment is a side effect — never fail the main action over it */
  }
}

// Can this user edit this goal (and its tasks)? Workspace admins + the creator
// always can; otherwise only assigned members who were granted can_edit.
export async function canEditGoal(user: { id: string; email: string; role: string }, goalId: string, wsId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", user.email.toLowerCase().trim(), wsId);
  const memberId = m?.id;
  let cur: string | null = goalId;
  let guard = 0;
  while (cur && guard++ < 30) {
    const node: { created_by: string | null; parent_goal_id: string | null } | null =
      await first("SELECT created_by, parent_goal_id FROM projects WHERE id = ?", cur);
    if (!node) break;
    if (node.created_by && node.created_by === user.id) return true;
    if (memberId) {
      const gm = await first<{ can_edit: number }>("SELECT can_edit FROM goal_members WHERE goal_id = ? AND member_id = ?", cur, memberId);
      if (gm && gm.can_edit === 1) return true;
    }
    cur = node.parent_goal_id;
  }
  return false;
}
export async function nodeGoalId(nodeId: string, wsId: string): Promise<string | null> {
  const n = await first<{ project_id: string }>("SELECT project_id FROM nodes WHERE id = ? AND workspace_id = ?", nodeId, wsId);
  return n?.project_id ?? null;
}

// ---------------- node (task) members: who holds each task ----------------
// All assignments for tasks under one goal, keyed for the client tree.
export async function listNodeMembersByGoal(goalId: string, wsId: string) {
  return all(
    `SELECT nm.node_id, m.id, m.name, m.email, m.avatar, m.is_you
     FROM node_members nm
     JOIN nodes n ON n.id = nm.node_id
     JOIN members m ON m.id = nm.member_id
     WHERE n.project_id = ? AND n.workspace_id = ? ORDER BY nm.assigned_at ASC`,
    goalId, wsId
  );
}
export async function assignNodeMember(nodeId: string, memberId: string) {
  await run("INSERT OR IGNORE INTO node_members (node_id, member_id) VALUES (?,?)", nodeId, memberId);
}
export async function unassignNodeMember(nodeId: string, memberId: string) {
  await run("DELETE FROM node_members WHERE node_id = ? AND member_id = ?", nodeId, memberId);
}

// Ensure the logged-in user has a linked roster member (by email) so assignment
// + "my tasks" work. Links an unlinked seeded member, else creates one.
export async function ensureMemberForUser(user: { email: string; name: string | null; role: string }, wsId: string) {
  const email = user.email.toLowerCase().trim();
  if (!email) return;
  const existing = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", email, wsId);
  if (existing) return;
  // "あなた" is determined per-viewer by email match (NOT a stored is_you flag),
  // so members joining later don't inherit someone else's "you" badge.
  await run(
    "INSERT INTO members (id, name, role, email, workspace_id) VALUES (?,?,?,?,?)",
    uid(), user.name || email, user.role === "admin" ? "Admin" : "None", email, wsId
  );
}

// Current user's own profile (linked roster member) + avatar update.
export async function getMyProfile(user: { email: string; name: string | null; role: string }, wsId: string) {
  await ensureMemberForUser(user, wsId);
  const m = await first<{ id: string; name: string; avatar: string | null }>(
    "SELECT id, name, avatar FROM members WHERE email = ? AND workspace_id = ?",
    user.email.toLowerCase().trim(), wsId
  );
  return m ?? { id: "", name: user.name ?? user.email, avatar: null };
}
export async function updateMyAvatar(user: { email: string }, avatar: string | null, wsId: string) {
  await run("UPDATE members SET avatar = ? WHERE email = ? AND workspace_id = ?", avatar, user.email.toLowerCase().trim(), wsId);
}

// Tasks assigned to the logged-in user, with their parent goal.
export async function listMyTasks(user: { email: string }, wsId: string) {
  const email = user.email.toLowerCase().trim();
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", email, wsId);
  if (!m) return [];
  return all(
    `SELECT n.id, n.text, n.completed_at, n.project_id, p.name AS goal_name, p.emoji AS goal_emoji
     FROM node_members nm
     JOIN nodes n ON n.id = nm.node_id
     JOIN projects p ON p.id = n.project_id
     WHERE nm.member_id = ? AND p.status != 'archived' AND p.workspace_id = ?
     ORDER BY (n.completed_at IS NOT NULL) ASC, p.name ASC, n.order_idx ASC`,
    m.id, wsId
  );
}
