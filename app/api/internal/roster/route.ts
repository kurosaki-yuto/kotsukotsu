import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { json, bad, all } from "../../../lib/server/db";

/** Constant-time-ish string compare to avoid trivial timing leaks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// こつこつシリーズの他の製品へ「こつこつのメンバーは誰か」を渡す口。
//
// 何のためにあるか: users は こつこつ 全体で1つなので、照合 (verify-login) を通るのは
// 「こつこつのアカウントを持っている人」であって「あなたのワークスペースの人」ではない。
// 営業・マーケ・会計・契約が verify-login だけで人を作ると、別のワークスペースの人が
// 一覧に並んでしまう。誰を載せてよいかは名簿 (members) がワークスペース単位で持っている
// ので、そこを引いて返す。
//
// userId は問い合わせ元の製品が持っている こつこつ側の users.id (SSO で受け取ったもの)。
// その人が入っているワークスペース全部の名簿を足して返す。複数に入っている人は、
// どちらの製品からでも同じ答えになる。
//
// 呼び出しは service binding 経由に限り、SSO_SECRET でも守る
// (*.workers.dev 同士の fetch は Cloudflare に塞がれて 404 になる)。
export async function POST(req: Request) {
  const env = getCloudflareContext().env as unknown as { SSO_SECRET?: string };
  const secret = env.SSO_SECRET;
  if (!secret) return json({ error: "not configured" }, { status: 501 });
  if (!safeEqual(req.headers.get("x-sso-secret") ?? "", secret)) {
    return json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { userId?: string; workspaceId?: string };
  const userId = (body.userId ?? "").trim();
  const workspaceId = (body.workspaceId ?? "").trim();
  if (!userId && !workspaceId) return bad("userId or workspaceId required", 400);

  // 名簿 (members) と、ログインできる人 (workspace_members → users) の両方を足す。
  // 名簿は招待前でも行が立つ。ログイン側は名簿に行が無い状態でも入れることがある。
  // どちらか片方でも「このワークスペースの人」なので、両方を載せる。
  // workspaceId が来たらそのワークスペース1つ。userId だけなら、その人が入っている
  // ワークスペース全部を足す (ワークスペース対応より前の製品はこちらで呼んでくる)。
  const rows = workspaceId
    ? await all<{ email: string | null }>(
        `SELECT m.email AS email FROM members m WHERE m.workspace_id = ?
          UNION
         SELECT u.email AS email
           FROM workspace_members wm JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = ?`,
        workspaceId,
        workspaceId
      )
    : await all<{ email: string | null }>(
        `SELECT m.email AS email
           FROM members m
          WHERE m.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)
          UNION
         SELECT u.email AS email
           FROM workspace_members wm
           JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)`,
        userId,
        userId
      );

  const emails = [
    ...new Set(
      rows
        .map((r) => (r.email ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0)
    ),
  ];

  // 空で返さない。呼ぶ側は「0人 = 取れなかった」と区別できないと、
  // 一覧を全部消してしまう。名簿が引けなかったときは ok:false で伝える。
  if (!emails.length) return json({ ok: false, reason: "no workspace" });

  return json({ ok: true, emails });
}
