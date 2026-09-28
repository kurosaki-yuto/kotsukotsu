import "server-only";

// こつこつシリーズ 共通ログイン (本体側の道具)
//
// 本体がシリーズの認証元。パスワードもセッションもここにしか無い。
// 他の4製品は別 Worker で動いていて、*.workers.dev は Public Suffix なので
// cookie を共有できない。そこで「署名付きの切符を1往復させる」形で状態を渡す。
//
//   authorize: 本体にログイン済みなら、宛先の製品向けに auth の切符を出す
//   adopt:     製品側でパスワードが通った人を、本体でもログイン済みにする
//
// 切符は署名だけで守る。保存しない。有効期限は 45 秒 (URL に乗って一往復するだけ)。
// aud (宛先) を必ず確かめること。宛先違いの切符を通したら共通ログインの意味が無い。
// 使い捨てにはしていない。45秒の窓の中で URL ごと盗まれた場合だけ再利用されうる。
// 各製品側の src/sso.js と同じ形式なので、直すときは両方を直す。

const TTL = 45;
export const ADOPT_AUD = "kotsukotsu";

const te = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unb64u(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(data))));
}

export type Ticket = {
  v: 1;
  iat: number;
  exp: number;
  typ: "auth" | "adopt";
  aud: string;
  iss?: string;
  sub?: string;
  email?: string;
  name?: string;
  role?: string;
  // どのワークスペースとして入るか。製品側はこれを自分の側の所属として保存する。
  ws?: string;
  wsName?: string;
  wsRole?: string;
};

export async function signTicket(secret: string, payload: Omit<Ticket, "v" | "iat" | "exp">): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(te.encode(JSON.stringify({ v: 1, iat: now, exp: now + TTL, ...payload })));
  return `${body}.${await hmac(secret, body)}`;
}

/** 署名と期限だけ確かめる。typ と aud は呼ぶ側が確かめること。 */
export async function verifyTicket(secret: string, token: string | null): Promise<Ticket | null> {
  if (!token || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!eq(sig, await hmac(secret, body))) return null;
  let payload: Ticket;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64u(body))) as Ticket;
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** 切符の付いた URL を次のページへ漏らさずに飛ばす。 */
export function seeOther(to: string, setCookie?: string): Response {
  const h = new Headers({
    location: to,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  if (setCookie) h.append("set-cookie", setCookie);
  return new Response(null, { status: 303, headers: h });
}

/** 製品へ戻すときの ?sso=... を、既にあるクエリを壊さずに足す。 */
export function withFlag(url: string, flag: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}sso=${flag}`;
}

/** 戻り先のパス。外部サイトへ飛ばされないよう絶対パスだけ通す。 */
export function safePath(raw: string | null): string {
  const r = raw ?? "";
  if (!r.startsWith("/") || r.startsWith("//")) return "/";
  return r;
}
