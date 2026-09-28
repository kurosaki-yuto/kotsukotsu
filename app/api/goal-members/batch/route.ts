import { requireWorkspace } from "../../../lib/server/workspace";
import { json } from "../../../lib/server/db";
import { listGoalMembersBatch, listGoalMembersAll, listGoals } from "../../../lib/server/queries";

// Assignees for many goals in one request — see listGoalMembersBatch for why.
export async function POST(req: Request) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  // scoped member: one recursive query for the whole allowed subtree instead of
  // one goalInScope() walk per requested id (2,000 ids = 2,000 queries).
  let allowedIds = ids;
  if (wctx.scopeGoalId) {
    const inScope = new Set(((await listGoals(wctx.workspaceId, wctx.scopeGoalId)) as { id: string }[]).map((g) => g.id));
    allowedIds = ids.filter((id) => inScope.has(id));
  }
  const byGoal = await listGoalMembersBatch(allowedIds, wctx.workspaceId);
  const out: Record<string, unknown[]> = {};
  for (const [id, members] of Object.entries(byGoal)) {
    out[id] = members.map((m) => ({ ...m, can_edit: !!m.can_edit, is_you: !!m.is_you }));
  }
  return json(out);
}

// GET ?all=1 — assignees for every visible goal without shipping 2,000 ids up
// first, so the client can fire it in parallel with /api/goals.
export async function GET(req: Request) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  const byGoal = await listGoalMembersAll(wctx.workspaceId, wctx.scopeGoalId);
  const out: Record<string, unknown[]> = {};
  for (const [id, members] of Object.entries(byGoal)) {
    out[id] = members.map((m) => ({ ...m, can_edit: !!m.can_edit, is_you: !!m.is_you }));
  }
  return json(out);
}
