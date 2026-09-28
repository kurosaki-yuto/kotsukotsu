import { json } from "../../../lib/server/db";
import { requireUser, countUsers, ensureAdmin } from "../../../lib/server/auth";
import { requireWorkspace } from "../../../lib/server/workspace";
import { ensureMemberForUser } from "../../../lib/server/queries";

export async function GET(req: Request) {
  const total = await countUsers();
  if (total > 0) await ensureAdmin(); // promote earliest user if no admin yet
  const user = await requireUser(req);
  let scopeGoalId: string | null = null;
  if (user) {
    // link the logged-in user to a roster member in their active workspace, and
    // expose the ACTIVE-WORKSPACE role (not the global one) so the UI matches
    // what the server actually allows — e.g. a new user who owns their own
    // workspace is admin there and must see the "create goal" controls.
    const ctx = await requireWorkspace(req);
    if (ctx) {
      await ensureMemberForUser(user, ctx.workspaceId);
      user.role = ctx.role;
      scopeGoalId = ctx.scopeGoalId; // task-scoped member -> their goal subtree
    }
  }
  return json({ user, needsBootstrap: total === 0, scopeGoalId });
}
