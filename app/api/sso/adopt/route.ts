import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { findUserByEmail, createSession, sessionCookie } from "../../../lib/server/auth";
import { seriesOrigins, productByKey } from "../../../lib/series";
import { verifyTicket, seeOther, withFlag, ADOPT_AUD } from "../../../lib/server/sso";

// こつこつシリーズ 共通ログインの逆向き (本体側)。
//
// 営業 / マーケ / 会計 / 契約 の画面でパスワードを入れて入った直後、画面がここへ
// 一度だけ寄り道してくる。
//   GET /api/sso/adopt?t=<製品が署名した切符>&r=<製品側の戻り先URL>
//
// パスワードの照合自体は /api/internal/verify-login で本体がやっているので、
// ここに来る時点で「本体の利用者である」ことは確認済み。本体側にもセッションを張って、
// 次にどの製品を開いても素通しできる状態にする。
//
// 切符は SSO_SECRET で署名されている。この鍵を持っているのはシリーズの製品だけで、
// 同じ鍵で /api/internal/verify-login も守られている。信頼の範囲は元から同じ。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const allowed = seriesOrigins(url.host).filter((o) => o !== url.origin);

  // 戻り先は製品の公開URLに限る。ここを緩めると外部サイトへ飛ばせる。
  const rawBack = url.searchParams.get("r") ?? "";
  let back = "";
  try {
    const u = new URL(rawBack);
    if (allowed.includes(u.origin)) back = u.toString();
  } catch {
    back = "";
  }
  if (!back) return new Response("unknown app", { status: 400 });

  const env = getCloudflareContext().env as unknown as { SSO_SECRET?: string };
  const secret = env.SSO_SECRET;
  if (!secret) return seeOther(withFlag(back, "none"));

  const t = await verifyTicket(secret, url.searchParams.get("t"));
  if (!t || t.typ !== "adopt" || t.aud !== ADOPT_AUD) return seeOther(withFlag(back, "err"));
  if (!t.iss || !productByKey(t.iss)) return seeOther(withFlag(back, "err"));
  if (!t.email) return seeOther(withFlag(back, "err"));

  const user = await findUserByEmail(t.email);
  // 本体に居ない人は本体のセッションを持てない。製品側のセッションはもう有るので、
  // そのまま戻して製品だけ使ってもらう。
  if (!user) return seeOther(back);

  const { token, expires } = await createSession(user.id);
  return seeOther(back, sessionCookie(token, expires));
}
