import { getCloudflareContext } from "@opennextjs/cloudflare";
import { json, bad, run, first } from "../../../lib/server/db";
import { createUser, createSession, sessionCookie, passwordProblem, PASSWORD_MIN } from "../../../lib/server/auth";
import { getValidInvite } from "../../../lib/server/queries";
import { joinViaInvite, inviteEmailMatches, createWorkspace } from "../../../lib/server/workspace";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string; invite?: string };
  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  const name = (body.name ?? "").trim();
  if (!email || !password || !name) return bad("email, name and password required", 400);
  if (passwordProblem(password)) return bad(`パスワードは${PASSWORD_MIN}文字以上にしてください`, 400);

  // Optional invite → role from invite + consume it + add to the member roster.
  let role: string | undefined;
  const invite = body.invite ? await getValidInvite(body.invite) : null;
  if (body.invite && !invite) return bad("招待が無効か期限切れです", 400);
  if (invite && !inviteEmailMatches(invite, email)) return bad("この招待は別のメールアドレス宛です", 400);
  if (invite) role = invite.role;

  // SIGNUP_MODE=invite (自社専用版の既定): 最初の1人 (管理者) だけ招待なしで登録でき、
  // 以降は招待リンクからしか入れない。URL を知った部外者が勝手に登録できないようにする。
  const mode = (getCloudflareContext().env as unknown as { SIGNUP_MODE?: string }).SIGNUP_MODE;
  if (mode === "invite" && !invite) {
    const any = await first("SELECT 1 AS ok FROM users LIMIT 1");
    if (any) return bad("新規登録は招待制です。管理者から招待リンクをもらってください", 403);
  }

  // Open self-registration is allowed. Invited users join the invite's existing
  // workspace; everyone else gets a fresh personal workspace they own.
  try {
    const user = await createUser(email, password, name, role);
    let workspaceId: string;
    if (invite) {
      workspaceId = await joinViaInvite(invite, user);
    } else {
      // brand-new personal workspace; the registrant becomes its admin + member
      const ws = await createWorkspace(user, `${name}のワークスペース`);
      workspaceId = ws.id;
    }
    const { token, expires } = await createSession(user.id);
    await run("UPDATE sessions SET active_workspace_id = ? WHERE token = ?", workspaceId, token);
    const res = json({ user });
    res.headers.append("set-cookie", sessionCookie(token, expires));
    return res;
  } catch {
    return bad("email taken", 409);
  }
}
