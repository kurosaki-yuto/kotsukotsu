import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// どこで動いているかの違いを、ここ1か所に閉じ込める。
//
// - Cloudflare (既定): D1・R2・シークレットは Worker の env にある (OpenNext の getCloudflareContext)
// - Node (Docker 版。KOTSUKOTSU_RUNTIME=node): node-server/server.mjs が起動時に同じ形の env を作って
//   globalThis.__KOTSUKOTSU_ENV に置く (DB は SQLite を D1 と同じ形で包んだもの、FILES はディスク)
//
// アプリのコードは env の中身の形 (DB.prepare / FILES.put など) だけに依存し、どちらで動いているかは気にしない。
export const IS_NODE_RUNTIME = process.env.KOTSUKOTSU_RUNTIME === "node";

export function platformEnv<T = Record<string, unknown>>(): T {
  if (IS_NODE_RUNTIME) {
    const env = (globalThis as { __KOTSUKOTSU_ENV?: unknown }).__KOTSUKOTSU_ENV;
    if (!env) throw new Error("KOTSUKOTSU_RUNTIME=node なのに env がありません。node-server/server.mjs から起動してください。");
    return env as T;
  }
  return getCloudflareContext().env as unknown as T;
}

/** レスポンスを返したあとも続けたい処理 (Push・リアルタイム通知)。Node ではプロセスが生きているのでそのまま走らせる。 */
export function waitUntil(p: Promise<unknown>): void {
  const guarded = p.catch(() => undefined);
  if (IS_NODE_RUNTIME) return;
  try {
    const ctx = (getCloudflareContext() as unknown as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } }).ctx;
    ctx?.waitUntil?.(guarded);
  } catch {
    /* 実行コンテキストが無い (ビルド時など) */
  }
}

/** 招待リンク・再設定リンクなどに使う、外から見たアドレス。
 *  Docker 版は Next.js が内側の待ち受けアドレス (localhost:3000) でリクエストを見るので、
 *  BASE_URL (.env) か、node-server が付ける X-Forwarded-* を使う。 */
export function publicOrigin(req: Request): string {
  if (IS_NODE_RUNTIME) {
    if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (host) return `${req.headers.get("x-forwarded-proto") || "http"}://${host}`;
  }
  return new URL(req.url).origin;
}
