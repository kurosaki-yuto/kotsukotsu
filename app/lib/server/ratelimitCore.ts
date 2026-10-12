// 回数制限。login_failures テーブル (key / count / window_start) を汎用のカウンタとして使う。
// Web と mcp-worker の両方から使うので、ここは D1 を引数に取る純粋な関数だけ (server-only を import しない)。
//
// 使い方: await rateLimited(db, "register:ip:1.2.3.4", 10, 60 * 60_000) → true なら止める。
// 窓 (windowMs) の中で limit 回を超えたら true。窓を過ぎたら 1 から数え直す。
// 1 回の呼び出しで必ず 1 回数えるので、「止めたあとも数え続ける」(止められた側が待つほど窓が延びない) 形。

export async function rateLimited(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const since = new Date(now - windowMs).toISOString();
  await db
    .prepare(
      `INSERT INTO login_failures (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start > ? THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN window_start > ? THEN window_start ELSE excluded.window_start END`
    )
    .bind(key, nowIso, since, since)
    .run();
  const r = await db.prepare("SELECT count FROM login_failures WHERE key = ?").bind(key).first<{ count: number }>();
  return (r?.count ?? 0) > limit;
}

// 数えずに「もう超えているか」だけ見る (失敗だけ数えたいときは、先にこれで見て、失敗したときだけ rateLimited で数える)
export async function rateLimitExceeded(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const r = await db.prepare("SELECT count FROM login_failures WHERE key = ? AND window_start > ?").bind(key, since).first<{ count: number }>();
  return (r?.count ?? 0) > limit;
}

// 一度しか使えない印 (OAuth の認可コードなど)。同じ key を 2 回目に呼ぶと false。
export async function claimOnce(db: D1Database, key: string): Promise<boolean> {
  const r = await db
    .prepare("INSERT OR IGNORE INTO login_failures (key, count, window_start) VALUES (?, 1, ?)")
    .bind(key, new Date().toISOString())
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

// 短いハッシュ。鍵そのものをカウンタのキーに入れない (ログやダンプに鍵が残らないように)。
export async function shortHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
