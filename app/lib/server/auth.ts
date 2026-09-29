import "server-only";
import { all, first, run, uid, nowIso } from "./db";

export type SessionUser = { id: string; email: string; name: string | null; role: string };

const PBKDF2_ITER = 100_000;
const SESSION_DAYS = 30;
export const SESSION_COOKIE = "sid";

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randHex(bytes = 16): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PBKDF2_ITER, hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits);
}

// constant-time-ish compare
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function countUsers(): Promise<number> {
  const r = await first<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  return r?.c ?? 0;
}

export async function createUser(email: string, password: string, name?: string, role?: string): Promise<SessionUser> {
  const salt = randHex(16);
  const hash = await hashPassword(password, salt);
  const id = uid();
  // First user in the workspace becomes admin; everyone else is a member.
  const r = role ?? ((await countUsers()) === 0 ? "admin" : "member");
  await run(
    "INSERT INTO users (id, email, password_hash, salt, name, role) VALUES (?,?,?,?,?,?)",
    id, email.toLowerCase().trim(), hash, salt, name ?? null, r
  );
  return { id, email: email.toLowerCase().trim(), name: name ?? null, role: r };
}

// Authenticate by email + password.
export async function verifyLogin(email: string, password: string): Promise<SessionUser | null> {
  const u = await first<{ id: string; email: string; name: string | null; role: string; password_hash: string; salt: string }>(
    "SELECT id, email, name, role, password_hash, salt FROM users WHERE email = ?",
    email.toLowerCase().trim()
  );
  if (!u) return null;
  const hash = await hashPassword(password, u.salt);
  if (!eq(hash, u.password_hash)) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

// ---- ログインの総当たり対策 ----
// 同じメールアドレスへの失敗が15分で10回、同じ接続元からの失敗が15分で50回を超えたら、
// 正しいパスワードでも15分は通さない。成功したらそのメールアドレスの回数は消す。
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = { email: 10, ip: 50 } as const;

export function loginThrottleKeys(email: string, ip: string | null): { key: string; limit: number }[] {
  const keys: { key: string; limit: number }[] = [{ key: `email:${email.toLowerCase().trim()}`, limit: FAIL_LIMIT.email }];
  if (ip) keys.push({ key: `ip:${ip}`, limit: FAIL_LIMIT.ip });
  return keys;
}

export async function loginBlocked(keys: { key: string; limit: number }[]): Promise<boolean> {
  const since = new Date(Date.now() - FAIL_WINDOW_MS).toISOString();
  for (const k of keys) {
    const r = await first<{ count: number }>("SELECT count FROM login_failures WHERE key = ? AND window_start > ?", k.key, since);
    if (r && r.count >= k.limit) return true;
  }
  return false;
}

export async function recordLoginFailure(keys: { key: string; limit: number }[]): Promise<void> {
  const now = new Date().toISOString();
  const since = new Date(Date.now() - FAIL_WINDOW_MS).toISOString();
  for (const k of keys) {
    await run(
      `INSERT INTO login_failures (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start > ? THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN window_start > ? THEN window_start ELSE excluded.window_start END`,
      k.key, now, since, since
    );
  }
}

export async function clearLoginFailures(email: string): Promise<void> {
  await run("DELETE FROM login_failures WHERE key = ?", `email:${email.toLowerCase().trim()}`);
}

// Minimum we enforce anywhere a password is set. Length beats composition
// rules, so that is the only bar — but it is checked on the server, because the
// client-side `minLength` is a hint, not a control.
export const PASSWORD_MIN = 8;

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `password too short`;
  return null;
}

// Set a new password and cut every session except (optionally) the one the
// caller is using right now. Changing a password is how someone locks an
// intruder out, so leaving other devices signed in would defeat the point.
export async function setPassword(userId: string, password: string, keepToken?: string | null): Promise<void> {
  const salt = randHex(16);
  const hash = await hashPassword(password, salt);
  await run("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", hash, salt, userId);
  if (keepToken) {
    await run("DELETE FROM sessions WHERE user_id = ? AND token != ?", userId, keepToken);
  } else {
    await run("DELETE FROM sessions WHERE user_id = ?", userId);
  }
}

// Confirm the current password before allowing a change from the settings
// screen — a session left open on an unattended machine must not be enough to
// take the account over.
export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const u = await first<{ password_hash: string; salt: string }>(
    "SELECT password_hash, salt FROM users WHERE id = ?",
    userId
  );
  if (!u) return false;
  return eq(await hashPassword(password, u.salt), u.password_hash);
}

// ---------- password reset ----------

const RESET_TTL_MIN = 60;
// A burst of requests for one address is either a mistake or someone probing;
// either way there is no reason to keep minting live tokens.
const RESET_MAX_PER_HOUR = 5;

export type ResetUser = { id: string; email: string; name: string | null };

export async function findUserByEmail(email: string): Promise<ResetUser | null> {
  return first<ResetUser>("SELECT id, email, name FROM users WHERE email = ?", email.toLowerCase().trim());
}

export async function recentResetCount(userId: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const r = await first<{ c: number }>(
    "SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ? AND created_at > ?",
    userId,
    since
  );
  return r?.c ?? 0;
}

// `revokeEarlier` を立てると、それまでのリンクを使えなくする。管理者が発行し直す
// ときに使う (LINE などで渡したリンクが別の所へ流れても、発行し直せば止まる)。
// 本人がログイン画面から頼むときは立てない。メールは本人の受信箱にしか届かないので
// 前のリンクを残しても危険は増えず、2回頼んだ人が1通目を開いて「使用済み」で
// 止まることが実際に起きたため (2026-09-29)。どのリンクでも再設定が済めば、
// consumePasswordReset が残りをまとめて使えなくする。
export async function createPasswordReset(
  userId: string,
  requestedBy?: string | null,
  ttlMin: number = RESET_TTL_MIN,
  opts: { revokeEarlier?: boolean } = {},
): Promise<{ token: string; expires: Date }> {
  if (opts.revokeEarlier) {
    await run("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL", nowIso(), userId);
  }
  const token = randHex(32);
  const expires = new Date(Date.now() + ttlMin * 60_000);
  await run(
    "INSERT INTO password_resets (token, user_id, created_at, expires_at, requested_by) VALUES (?,?,?,?,?)",
    token, userId, nowIso(), expires.toISOString(), requestedBy ?? null
  );
  return { token, expires };
}

export type ResetCheck = { ok: true; user: ResetUser } | { ok: false; reason: "invalid" | "expired" | "used" };

export async function checkPasswordReset(token: string): Promise<ResetCheck> {
  const r = await first<{ user_id: string; expires_at: string; used_at: string | null }>(
    "SELECT user_id, expires_at, used_at FROM password_resets WHERE token = ?",
    token
  );
  if (!r) return { ok: false, reason: "invalid" };
  if (r.used_at) return { ok: false, reason: "used" };
  if (new Date(r.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };
  const u = await first<ResetUser>("SELECT id, email, name FROM users WHERE id = ?", r.user_id);
  if (!u) return { ok: false, reason: "invalid" };
  return { ok: true, user: u };
}

// 使ったリンクと、同じ人のまだ使っていないリンクをまとめて使えなくする。
export async function consumePasswordReset(token: string): Promise<void> {
  await run(
    `UPDATE password_resets SET used_at = ?
      WHERE used_at IS NULL
        AND user_id = (SELECT user_id FROM password_resets WHERE token = ?)`,
    nowIso(), token
  );
}

export async function createSession(userId: string): Promise<{ token: string; expires: Date }> {
  const token = randHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await run(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
    token, userId, nowIso(), expires.toISOString()
  );
  return { token, expires };
}

export async function getSessionUser(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const s = await first<{ user_id: string; expires_at: string }>(
    "SELECT user_id, expires_at FROM sessions WHERE token = ?",
    token
  );
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    await run("DELETE FROM sessions WHERE token = ?", token);
    return null;
  }
  const u = await first<SessionUser>("SELECT id, email, name, role FROM users WHERE id = ?", s.user_id);
  return u ?? null;
}

// Ensure at least one admin exists (promote the earliest user). Idempotent.
export async function ensureAdmin(): Promise<void> {
  const a = await first<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
  if ((a?.c ?? 0) > 0) return;
  await run("UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)");
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (token) await run("DELETE FROM sessions WHERE token = ?", token);
}

export function sessionCookie(token: string, expires: Date): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=${expires.toUTCString()}`;
}
export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export function readCookie(req: Request, name: string): string | undefined {
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx) === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return undefined;
}
export async function requireUser(req: Request): Promise<SessionUser | null> {
  return getSessionUser(readCookie(req, SESSION_COOKIE));
}
export async function requireAdmin(req: Request): Promise<SessionUser | null> {
  const u = await requireUser(req);
  return u && u.role === "admin" ? u : null;
}

// MCP token guard for the remote MCP worker / API
export function checkMcpToken(req: Request, expected?: string): boolean {
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && eq(m[1], expected);
}
export { all };
