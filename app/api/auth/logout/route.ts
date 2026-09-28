import { json } from "../../../lib/server/db";
import { destroySession, clearCookie, readCookie, SESSION_COOKIE } from "../../../lib/server/auth";

export async function POST(req: Request) {
  const token = readCookie(req, SESSION_COOKIE);
  await destroySession(token);
  const res = json({ ok: true });
  res.headers.append("set-cookie", clearCookie());
  return res;
}
