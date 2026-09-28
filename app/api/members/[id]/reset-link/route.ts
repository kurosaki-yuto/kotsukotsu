import { json, first } from "../../../../lib/server/db";
import { requireWorkspace } from "../../../../lib/server/workspace";
import { createPasswordReset } from "../../../../lib/server/auth";

// 管理者が、パスワードを忘れたメンバーのために再設定リンクを発行する。
// メール送信の代わりに、管理者がこのリンクを LINE や Chatwork で本人に渡す。
// リンクは24時間・1回限り。発行し直すと前のリンクは使えなくなる。
//
// 発行できるのは「このワークスペースにだけ所属している人」に限る。アカウントは
// ワークスペースをまたいで1つなので、別の会社のワークスペースにも入っている人の
// パスワードをここで変えられると、その会社のデータまで乗っ取れてしまう。
const ADMIN_RESET_TTL_MIN = 24 * 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const wctx = await requireWorkspace(req);
  if (!wctx) return json({ error: "unauthorized" }, { status: 401 });
  if (wctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const member = await first<{ email: string | null }>(
    "SELECT email FROM members WHERE id = ? AND workspace_id = ?", id, wctx.workspaceId
  );
  if (!member?.email) return json({ error: "このメンバーにはログイン用のアカウントがありません" }, { status: 404 });
  const user = await first<{ id: string }>("SELECT id FROM users WHERE email = ?", member.email.toLowerCase().trim());
  if (!user) return json({ error: "このメンバーにはログイン用のアカウントがありません" }, { status: 404 });

  const ws = await first<{ n: number; here: number }>(
    `SELECT COUNT(DISTINCT workspace_id) AS n,
            SUM(CASE WHEN workspace_id = ? THEN 1 ELSE 0 END) AS here
       FROM workspace_members WHERE user_id = ?`,
    wctx.workspaceId, user.id
  );
  if (!ws?.here) return json({ error: "このワークスペースのメンバーではありません" }, { status: 404 });
  if (ws.n > 1) {
    return json(
      { error: "この人は他のワークスペースにも所属しているため、ここからは再設定できません。本人にログイン画面の「パスワードをお忘れですか？」を使ってもらってください" },
      { status: 409 }
    );
  }

  const { token, expires } = await createPasswordReset(user.id, `admin:${wctx.user.id}`, ADMIN_RESET_TTL_MIN);
  return json({ url: `${new URL(req.url).origin}/reset/${token}`, expires_at: expires.toISOString() });
}
