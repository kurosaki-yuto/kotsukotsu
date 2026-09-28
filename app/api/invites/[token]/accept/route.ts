import { json, run, first } from "../../../../lib/server/db";
import { requireUser, readCookie, SESSION_COOKIE } from "../../../../lib/server/auth";
import { getValidInvite, getInvite } from "../../../../lib/server/queries";
import { joinViaInvite, inviteEmailMatches } from "../../../../lib/server/workspace";

// Accept an invite as an already-signed-in user: join the invite's workspace
// and switch the current session to it. Idempotent — a consumed token still
// succeeds when the caller already belongs to that workspace.
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const user = await requireUser(req);
  if (!user) return json({ error: "unauthorized" }, { status: 401 });
  const { token } = await ctx.params;
  const sid = readCookie(req, SESSION_COOKIE);

  const inv = await getValidInvite(token);
  if (inv && !inviteEmailMatches(inv, user.email)) {
    return json({ ok: false, error: "この招待は別のメールアドレス宛です" }, { status: 400 });
  }
  if (inv) {
    const ws = await joinViaInvite(inv, user);
    if (sid) await run("UPDATE sessions SET active_workspace_id = ? WHERE token = ?", ws, sid);
    return json({ ok: true, joined: true, workspaceId: ws });
  }

  const raw = await getInvite(token);
  if (raw) {
    const m = await first("SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?", raw.workspace_id, user.id);
    if (m) {
      if (sid) await run("UPDATE sessions SET active_workspace_id = ? WHERE token = ?", raw.workspace_id, sid);
      return json({ ok: true, joined: false, workspaceId: raw.workspace_id });
    }
  }
  return json({ ok: false, error: "招待が無効か期限切れです" }, { status: 400 });
}
