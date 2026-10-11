import "server-only";
import { db, json } from "./db";
import { rateLimited } from "./ratelimitCore";

export { rateLimited };

/** 接続元 IP。Cloudflare なら cf-connecting-ip、Docker 版は node-server が付ける x-forwarded-for の先頭。 */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

/** 超えていたら 429 の Response、まだなら null。ルートの先頭で `const r = await limitOr429(...); if (r) return r;` */
export async function limitOr429(key: string, limit: number, windowMs: number): Promise<Response | null> {
  if (await rateLimited(db(), key, limit, windowMs)) {
    return json({ error: "回数が多すぎます。しばらく待ってからやり直してください" }, { status: 429, headers: { "retry-after": String(Math.ceil(windowMs / 1000)) } });
  }
  return null;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
