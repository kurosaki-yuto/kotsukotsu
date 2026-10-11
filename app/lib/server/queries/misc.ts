import "server-only";
import { all, first, run, uid, nowIso } from "../db";

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
