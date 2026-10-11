import "server-only";
import { listGoals } from "./goals";
import { createNotification } from "./notifications";
import { all, first, run, uid } from "../db";

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
export const GOAL_ID_CHUNK = 50;

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
export async function listMemberGoals(memberId: string, wsId: string, scopeGoalId: string | null = null) {
  if (!scopeGoalId) {
    return all(
      `SELECT p.id, p.name, p.emoji, p.status, p.parent_goal_id, gm.can_edit
       FROM goal_members gm JOIN projects p ON p.id = gm.goal_id
       WHERE gm.member_id = ? AND p.status != 'archived' AND p.workspace_id = ?
       ORDER BY p.name ASC`,
      memberId, wsId
    );
  }
  // スコープ付きのゲストには、そのスコープの部分木にある担当だけ見せる
  return all(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM projects WHERE id = ? AND workspace_id = ?
       UNION
       SELECT c.id FROM sub CROSS JOIN projects c ON c.parent_goal_id = sub.id WHERE c.workspace_id = ?
     )
     SELECT p.id, p.name, p.emoji, p.status, p.parent_goal_id, gm.can_edit
     FROM goal_members gm JOIN projects p ON p.id = gm.goal_id
     WHERE gm.member_id = ? AND p.status != 'archived' AND p.workspace_id = ? AND p.id IN (SELECT id FROM sub)
     ORDER BY p.name ASC`,
    scopeGoalId, wsId, wsId, memberId, wsId
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
      await first("SELECT created_by, parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?", cur, wsId);
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
