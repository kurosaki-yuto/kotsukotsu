import { json } from "../../lib/server/db";
import { readCookie, SESSION_COOKIE } from "../../lib/server/auth";
import { requireWorkspace, listUserWorkspaces, createWorkspace } from "../../lib/server/workspace";

// List the workspaces the caller belongs to, plus which one is active.
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const workspaces = await listUserWorkspaces(ctx.user.id);
  return json({ workspaces, activeId: ctx.workspaceId });
}

// Any authenticated user can create a workspace (they become its admin).
export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const token = readCookie(req, SESSION_COOKIE);
  const ws = await createWorkspace(ctx.user, body.name ?? "", token);
  return json(ws);
}
