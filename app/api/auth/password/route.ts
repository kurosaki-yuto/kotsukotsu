import { json, bad } from "../../../lib/server/db";
import {
  requireUser,
  readCookie,
  SESSION_COOKIE,
  verifyPassword,
  setPassword,
  passwordProblem,
} from "../../../lib/server/auth";
import { sendMail, passwordChangedMail } from "../../../lib/server/email";

// Change your own password while signed in. The current password is required:
// a session alone must not be enough, or an unattended open laptop becomes a
// permanent account takeover.
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return bad("unauthorized", 401);

  const body = (await req.json().catch(() => ({}))) as { current?: string; password?: string };
  const current = body.current ?? "";
  const password = body.password ?? "";
  if (!current) return bad("current password required", 400);

  const problem = passwordProblem(password);
  if (problem) return bad(problem, 400);
  if (current === password) return bad("password unchanged", 400);

  if (!(await verifyPassword(user.id, current))) return bad("current password incorrect", 403);

  // Keep this device signed in; drop every other one.
  await setPassword(user.id, password, readCookie(req, SESSION_COOKIE));

  const mail = passwordChangedMail(user.name);
  await sendMail({ to: user.email, ...mail });

  return json({ ok: true });
}
