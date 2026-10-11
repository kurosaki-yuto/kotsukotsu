import "server-only";
import { all, first, run, uid, nowIso } from "../db";

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
