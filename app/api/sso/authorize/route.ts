import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "../../../lib/server/auth";
import { requireWorkspace } from "../../../lib/server/workspace";
import { first } from "../../../lib/server/db";
import { seriesOrigins } from "../../../lib/series";
import { signTicket, seeOther, withFlag, safePath } from "../../../lib/server/sso";

// こつこつシリーズ 共通ログインの入口 (本体側)。
//
// 営業 / マーケ / 会計 / 契約 でセッションが無いとき、画面がここへ寄り道してくる。
//   GET /api/sso/authorize?to=<製品の公開URL>&r=<製品側の戻り先パス>
//
// 本体にログインが残っていれば、その製品宛ての切符に署名して返す。
// 残っていなければ ?sso=none を付けて戻す (製品側は自分のログイン画面を出す)。
//
// to は必ずシリーズ5製品のどれかに一致させる。ここを緩めると、任意の URL へ
// ユーザーと切符を飛ばせるオープンリダイレクトになる。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const to = url.searchParams.get("to") ?? "";
  const back = safePath(url.searchParams.get("r"));

  const allowed = seriesOrigins(url.host).filter((o) => o !== url.origin);
  if (!allowed.includes(to)) {
    return new Response("unknown app", { status: 400 });
  }

  const env = getCloudflareContext().env as unknown as { SSO_SECRET?: string };
  const secret = env.SSO_SECRET;
  // 共通ログインが未設定なら、黙って素通しせず製品側のログイン画面へ返す。
  if (!secret) return seeOther(withFlag(to + back, "none"));

  const user = await requireUser(req);
  if (!user) return seeOther(withFlag(to + back, "none"));

  // どのワークスペースとして入るかまで切符に載せる。
  //
  // これが無いと、製品側は「こつこつのアカウントを持っているか」しか分からない。
  // users は こつこつ 全体で1つなので、それだけを通すと別の会社の人が入ってしまう
  // (2026-09-09 に こつこつ営業 で実際に起きた)。所属の判定は名簿を持っている
  // こちらでやり、結果を署名して渡す。製品側は署名を確かめるだけでよくなる。
  const ctx = await requireWorkspace(req);
  if (!ctx) return seeOther(withFlag(to + back, "none"));
  const ws = await first<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", ctx.workspaceId);

  const ticket = await signTicket(secret, {
    typ: "auth",
    aud: to,
    sub: user.id,
    email: user.email,
    name: user.name ?? "",
    role: user.role,
    ws: ctx.workspaceId,
    wsName: ws?.name ?? "",
    // 製品側での権限は、こつこつ の そのワークスペースでの役割をそのまま引き継ぐ。
    wsRole: ctx.role === "admin" ? "admin" : "member",
  });

  return seeOther(
    `${to}/sso/callback?t=${encodeURIComponent(ticket)}&r=${encodeURIComponent(back)}`
  );
}
