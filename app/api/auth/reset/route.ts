import { json, bad } from "../../../lib/server/db";
import {
  checkPasswordReset,
  consumePasswordReset,
  setPassword,
  passwordProblem,
  createSession,
  sessionCookie,
} from "../../../lib/server/auth";
import { sendMail, passwordChangedMail } from "../../../lib/server/email";

// GET /api/auth/reset?token=... — the reset page asks whether a link is still
// good before it shows the form, so a dead link says so up front instead of
// after the person has typed a new password twice.
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return bad("token required", 400);
  const c = await checkPasswordReset(token);
  if (!c.ok) return json({ valid: false, reason: c.reason });
  return json({ valid: true, email: c.user.email, name: c.user.name });
}

// POST — set the new password. The token is spent first so a replayed request
// cannot set the password a second time, then every existing session is dropped
// and the caller is signed in fresh on this device only.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; password?: string };
  const token = (body.token ?? "").trim();
  const password = body.password ?? "";
  if (!token) return bad("token required", 400);

  const problem = passwordProblem(password);
  if (problem) return bad(problem, 400);

  const c = await checkPasswordReset(token);
  if (!c.ok) return bad(`reset ${c.reason}`, 400);

  await consumePasswordReset(token);
  await setPassword(c.user.id, password);

  // Tell the account holder it happened. If this mail fails the reset still
  // stands — the password is already changed, and failing the request now would
  // only confuse the person who just changed it.
  const mail = passwordChangedMail(c.user.name);
  await sendMail({ to: c.user.email, ...mail });

  const { token: sid, expires } = await createSession(c.user.id);
  const res = json({ ok: true });
  res.headers.append("set-cookie", sessionCookie(sid, expires));
  return res;
}
