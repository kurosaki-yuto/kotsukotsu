import { json, bad } from "../../../lib/server/db";
import { requireUser, verifyPassword, clearCookie } from "../../../lib/server/auth";
import { accountPlan, deleteAccount } from "../../../lib/server/account";

// 退会の下見。どのワークスペースが消えるか / 抜けるだけか / 退会を止めているか を返す。
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (!user) return bad("unauthorized", 401);
  return json(await accountPlan(user.id));
}

// 退会の実行。セッションだけでは消せないよう、現在のパスワードを必須にする。
export async function POST(req: Request) {
  const user = await requireUser(req);
  if (!user) return bad("unauthorized", 401);

  const body = (await req.json().catch(() => ({}))) as { password?: string };
  if (!body.password) return bad("current password required", 400);
  if (!(await verifyPassword(user.id, body.password))) return bad("current password incorrect", 403);

  const r = await deleteAccount(user.id, user.email);
  if (!r.ok) return json({ error: "blocked", plan: r.plan }, { status: 409 });

  return json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
}
