import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { json, all } from "../../../lib/server/db";
import { verifyLogin } from "../../../lib/server/auth";

/** Constant-time-ish string compare to avoid trivial timing leaks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// こつこつシリーズの共通ログイン。
//
// こつこつ営業 / マーケ / 会計 / 契約 は別 Worker で動いていて、パスワードを自分では
// 持たない。ログインを受けたらこのエンドポイントに照合だけを頼み、成功したら自分の側で
// セッションを張る。こうしておくと、パスワードの置き場は こつこつ 1つだけになり、
// 変更や再設定も こつこつ でやれば全製品に効く。
//
// 呼び出しは service binding 経由に限る。*.workers.dev 同士の fetch は Cloudflare に
// 塞がれていて 404 になるため、公開URLでは呼べない (mcp-worker が同じ理由で binding を
// 使っている)。合わせて SSO_SECRET でも守る。
//
// 返すのは id / email / name / role だけ。パスワードハッシュは外に出さない。
export async function POST(req: Request) {
  const env = getCloudflareContext().env as unknown as { SSO_SECRET?: string };
  const secret = env.SSO_SECRET;
  if (!secret) return json({ error: "not configured" }, { status: 501 });

  const presented = req.headers.get("x-sso-secret") ?? "";
  if (!safeEqual(presented, secret)) return json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!email || !password) return json({ error: "email and password required" }, { status: 400 });

  const user = await verifyLogin(email, password);
  // 見つからないのと合っていないのを区別しない。どちらも ok:false で返す。
  if (!user) return json({ ok: false });

  // どのワークスペースの人かも返す。製品側は「こつこつのアカウントを持っている」だけでは
  // 誰の領域に入れてよいか決められないため (共通ログイン経由なら切符に載っているが、
  // 製品の画面で直接パスワードを入れた場合はここが唯一の手がかりになる)。
  // 先頭 = 入った順が一番古いワークスペース。製品側は既定でここに入れる。
  const workspaces = await all<{ id: string; name: string; role: string }>(
    `SELECT w.id, w.name, wm.role
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY wm.joined_at ASC`,
    user.id
  );
  // どこにも所属していない人は製品を使えない。空配列で返し、製品側が断る。
  return json({ ok: true, user, workspaces });
}
