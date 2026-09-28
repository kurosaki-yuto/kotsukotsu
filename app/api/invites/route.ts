import { json, first } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { createInvite, listInvites } from "../../lib/server/queries";
import { publicOrigin } from "@/app/lib/server/platform";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  return json(await listInvites(ctx.workspaceId));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string; goalId?: string };
  const goalId = body.goalId ?? null;

  if (goalId) {
    // Goal-scoped invite: the goal must be in this workspace and within the
    // caller's own scope, and the caller must be an admin or the goal's creator.
    if (!(await goalInScope(ctx.workspaceId, goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
    const g = await first<{ created_by: string | null }>("SELECT created_by FROM projects WHERE id = ? AND workspace_id = ?", goalId, ctx.workspaceId);
    if (!g) return json({ error: "not found" }, { status: 404 });
    if (ctx.role !== "admin" && g.created_by !== ctx.user.id) return json({ error: "forbidden" }, { status: 403 });
  } else {
    // Workspace-wide invite: admins only.
    if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  }

  const inv = (await createInvite({ email: body.email ?? null, role: body.role, createdBy: ctx.user.id, workspaceId: ctx.workspaceId, goalId })) as { token: string } | null;
  const origin = publicOrigin(req);
  return json({ invite: inv, url: inv ? `${origin}/login?invite=${inv.token}` : null });
}
