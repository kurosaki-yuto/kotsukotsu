import { json } from "../../../lib/server/db";
import { requireUser, readCookie, SESSION_COOKIE } from "../../../lib/server/auth";
import { switchWorkspace } from "../../../lib/server/workspace";

// Switch the active workspace for the current session.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return json({ error: "unauthorized" }, { status: 401 });
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { workspaceId?: string };
  if (!body.workspaceId) return json({ error: "workspaceId required" }, { status: 400 });
  const ok = await switchWorkspace(token, user.id, body.workspaceId);
  if (!ok) return json({ error: "forbidden" }, { status: 403 });
  return json({ ok: true });
}
