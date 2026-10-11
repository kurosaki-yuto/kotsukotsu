import "server-only";
import { createNotification } from "./notifications";
import { all, first, run, uid } from "../db";
import { validAvatar } from "../filesCore";

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
  // avatar は画像の data URL だけ (filesCore.validAvatar)。それ以外は捨てる
  if ("avatar" in patch && !validAvatar(patch.avatar)) delete patch.avatar;
  if ("role" in patch && patch.role !== "Admin" && patch.role !== "None") delete patch.role;
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
