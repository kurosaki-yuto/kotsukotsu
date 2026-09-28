import "server-only";
import { platformEnv } from "@/app/lib/server/platform";

export function db(): D1Database {
  const env = platformEnv<{ DB?: D1Database }>();
  if (!env?.DB) throw new Error("D1 binding 'DB' missing. Run wrangler d1 create + bind in wrangler.jsonc.");
  return env.DB;
}

export function uid(): string {
  return crypto.randomUUID();
}
export function nowIso(): string {
  return new Date().toISOString();
}

// query helpers
export async function all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> {
  const r = await db().prepare(sql).bind(...args).all<T>();
  return (r.results ?? []) as T[];
}
export async function first<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T | null> {
  const r = await db().prepare(sql).bind(...args).first<T>();
  return (r ?? null) as T | null;
}
export async function run(sql: string, ...args: unknown[]): Promise<void> {
  await db().prepare(sql).bind(...args).run();
}
export async function batch(stmts: { sql: string; args?: unknown[] }[]): Promise<void> {
  if (!stmts.length) return;
  const d = db();
  await d.batch(stmts.map((s) => d.prepare(s.sql).bind(...(s.args ?? []))));
}

// JSON response helpers
export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
  });
}
export function bad(msg: string, status = 400): Response {
  return json({ error: msg }, { status });
}
