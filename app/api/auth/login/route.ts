import { json, bad, run, first } from "../../../lib/server/db";
import { verifyLogin, createSession, sessionCookie } from "../../../lib/server/auth";
import { getValidInvite, getInvite } from "../../../lib/server/queries";
import { joinViaInvite, inviteEmailMatches } from "../../../lib/server/workspace";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; invite?: string };
  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!email || !password) return bad("email and password required", 400);

  const user = await verifyLogin(email, password);
  if (!user) return bad("invalid credentials", 401);

  // Optional invite: an existing account joins the invite's workspace on login.
  // A consumed/expired token is still honored when the user already belongs to
  // that workspace (re-clicking your own invite link); otherwise it is ignored
  // — login itself must not fail because of a stale invite.
  let activeWs: string | null = null;
  if (body.invite) {
    const inv = await getValidInvite(body.invite);
    if (inv && inviteEmailMatches(inv, user.email)) {
      activeWs = await joinViaInvite(inv, user);
    } else {
      const raw = await getInvite(body.invite);
      if (raw) {
        const m = await first("SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?", raw.workspace_id, user.id);
        if (m) activeWs = raw.workspace_id;
      }
    }
  }

  const { token, expires } = await createSession(user.id);
  if (activeWs) await run("UPDATE sessions SET active_workspace_id = ? WHERE token = ?", activeWs, token);
  const res = json({ user, joinedWorkspaceId: activeWs });
  res.headers.append("set-cookie", sessionCookie(token, expires));
  return res;
}
