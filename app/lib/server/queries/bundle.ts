import "server-only";
import { listResources } from "./misc";
import { listMessages } from "./chat";
import { getGoal, getAncestors, listChildren } from "./goals";
import { GOAL_ID_CHUNK, listGoalMembers, listGoalMembersBatch } from "./goalMembers";
import { all } from "../db";

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
