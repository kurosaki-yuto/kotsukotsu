import "server-only";
import { all, first, run, uid } from "./db";
import { SESSION_COOKIE, readCookie, type SessionUser } from "./auth";
import { acceptInvite, type InviteRow } from "./queries";

// A request's active workspace context: who the caller is, which workspace they
// are currently viewing, their role *in that workspace* (admin / member), and an
// optional goal scope. scopeGoalId !== null means the member is confined to that
// goal's subtree — they can neither see nor touch anything else.
export type WorkspaceCtx = { user: SessionUser; workspaceId: string; role: string; scopeGoalId: string | null };

// Resolve the caller's user + active workspace, verifying membership. If the
// session's active workspace is stale (user removed, deleted), fall back to the
// user's earliest workspace and persist it. Returns null when unauthenticated or
// the user belongs to no workspace.
export async function requireWorkspace(req: Request): Promise<WorkspaceCtx | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  // Single round-trip: session + user + active-workspace membership in one query
  // (was 3 sequential D1 queries — the dominant per-request latency).
  const row = await first<{
    user_id: string; expires_at: string; active_workspace_id: string;
    email: string; name: string | null; grole: string;
    ws_role: string | null; scope_goal_id: string | null;
  }>(
    `SELECT s.user_id, s.expires_at, s.active_workspace_id,
            u.email, u.name, u.role AS grole,
            wm.role AS ws_role, wm.scope_goal_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN workspace_members wm
         ON wm.workspace_id = s.active_workspace_id AND wm.user_id = s.user_id
      WHERE s.token = ?`,
    token
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await run("DELETE FROM sessions WHERE token = ?", token);
    return null;
  }
  const user: SessionUser = { id: row.user_id, email: row.email, name: row.name, role: row.grole };

  let wsId = row.active_workspace_id;
  let wsRole = row.ws_role;
  let scope = row.scope_goal_id;
  if (wsRole == null) {
    // active workspace membership is stale/missing → fall back to earliest membership
    const fb = await first<{ workspace_id: string; role: string; scope_goal_id: string | null }>(
      "SELECT workspace_id, role, scope_goal_id FROM workspace_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1",
      user.id
    );
    if (!fb) return null;
    wsId = fb.workspace_id; wsRole = fb.role; scope = fb.scope_goal_id;
    await run("UPDATE sessions SET active_workspace_id = ? WHERE token = ?", wsId, token);
  }
  return { user, workspaceId: wsId, role: wsRole, scopeGoalId: scope ?? null };
}

// Is `goalId` within the caller's scope? A null scope = the whole workspace.
// Otherwise the goal must BE the scope goal or a descendant of it.
export async function goalInScope(wsId: string, goalId: string, scopeGoalId: string | null): Promise<boolean> {
  if (!scopeGoalId) return true;
  let cur: string | null = goalId;
  let guard = 0;
  while (cur && guard++ < 50) {
    if (cur === scopeGoalId) return true;
    const r: { parent_goal_id: string | null } | null = await first(
      "SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?",
      cur, wsId
    );
    if (!r) return false;
    cur = r.parent_goal_id;
  }
  return false;
}

// Workspaces the user belongs to (powers the logo switcher).
export async function listUserWorkspaces(userId: string) {
  return all<{ id: string; name: string; role: string; logo_url: string | null }>(
    `SELECT w.id, w.name, w.logo_url, wm.role
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = ?
      ORDER BY w.created_at ASC`,
    userId
  );
}

// Point this session at a different workspace (verifies membership first).
export async function switchWorkspace(token: string, userId: string, workspaceId: string): Promise<boolean> {
  const m = await first("SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?", workspaceId, userId);
  if (!m) return false;
  await run("UPDATE sessions SET active_workspace_id = ? WHERE token = ?", workspaceId, token);
  return true;
}

// Add a user to a workspace (idempotent). role normalized to admin/member.
// scopeGoalId confines the member to one goal subtree (null = full access).
export async function enrollUser(workspaceId: string, userId: string, role = "member", scopeGoalId: string | null = null): Promise<void> {
  await run(
    "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, scope_goal_id) VALUES (?,?,?,?)",
    workspaceId, userId, role === "admin" ? "admin" : "member", scopeGoalId
  );
}

// Accept an invite on behalf of a user (new or existing): join the workspace,
// seed the roster member (reusing one that already carries their email), grant
// scoped-goal edit, and consume the token. Idempotent for repeat joins.
// A goal-scoped invite always joins as a plain member confined to that goal's
// subtree; a plain invite uses the invite's role with full access.
// An email-bound invite may only be redeemed by that address.
export function inviteEmailMatches(invite: InviteRow, userEmail: string): boolean {
  if (!invite.email) return true;
  return invite.email.trim().toLowerCase() === userEmail.trim().toLowerCase();
}

export async function joinViaInvite(invite: InviteRow, user: SessionUser): Promise<string> {
  const scopedGoal = invite.goal_id ?? null;
  const joinRole = scopedGoal ? "member" : invite.role === "admin" ? "admin" : "member";
  await enrollUser(invite.workspace_id, user.id, joinRole, scopedGoal);
  const email = user.email.toLowerCase().trim();
  let member = await first<{ id: string }>(
    "SELECT id FROM members WHERE workspace_id = ? AND lower(email) = ?",
    invite.workspace_id, email
  );
  if (!member) {
    const memberId = uid();
    await run(
      "INSERT INTO members (id, name, role, email, workspace_id) VALUES (?,?,?,?,?)",
      memberId, user.name || user.email, joinRole === "admin" ? "Admin" : "None", email, invite.workspace_id
    );
    member = { id: memberId };
  }
  if (scopedGoal) {
    // grant edit on the scope goal → canEditGoal lets them edit it + subtree
    await run("INSERT OR IGNORE INTO goal_members (goal_id, member_id, can_edit) VALUES (?,?,1)", scopedGoal, member.id);
  }
  await acceptInvite(invite.token, user.id);
  return invite.workspace_id;
}

// Create a new workspace; the creator becomes its admin + a roster member. If a
// session token is given, the session switches to the new workspace.
export async function createWorkspace(user: SessionUser, name: string, token?: string): Promise<{ id: string }> {
  const id = uid();
  const nm = name.trim() || "新しいワークスペース";
  await run("INSERT INTO workspaces (id, name, created_by) VALUES (?,?,?)", id, nm, user.id);
  await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?, 'admin')", id, user.id);
  // seed the creator as a roster member of the new workspace ("you" is matched
  // per-viewer by email, so no is_you flag is set here).
  await run(
    "INSERT INTO members (id, name, role, email, workspace_id) VALUES (?,?,?,?,?)",
    uid(), user.name || user.email, "Admin", user.email.toLowerCase().trim(), id
  );
  if (token) await run("UPDATE sessions SET active_workspace_id = ? WHERE token = ?", id, token);
  return { id };
}
