#!/usr/bin/env node
// 見える根の上の親は名前も返さない (AGENTS.md §5) ことを、Web の一覧 (my-tasks / my-turn / attention) と
// MCP (list_my_tasks / list_my_turn / list_today / status_report) で確かめる。管理者には今までどおり親の名前が出る。
// 手元の SQLite (node:sqlite, メモリ上) に d1-migrations を当てて、本番と同じ関数をそのまま呼ぶ。
//
// 使い方: node scripts/test-parent-names-scope.mjs
// 結果: 項目ごとに PASS / FAIL。FAIL が 1 つでもあれば exit 1。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { openD1, applyMigrations } from "../node-server/d1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kk-parent-names-"));

// 本番の関数を1つの ESM に束ねる。server-only と OpenNext は Node では要らないので空にする
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, [
  `export { listMyAssignedItems, listMyTurn } from ${JSON.stringify(path.join(ROOT, "app/lib/server/queries/goals.ts"))};`,
  `export { listAttention } from ${JSON.stringify(path.join(ROOT, "app/lib/server/queries/attention.ts"))};`,
  `export { todayTools } from ${JSON.stringify(path.join(ROOT, "mcp-worker/src/tools/today.ts"))};`,
  `export { statusReport } from ${JSON.stringify(path.join(ROOT, "mcp-worker/src/tools/status.ts"))};`,
].join("\n"));
const stub = path.join(tmp, "stub.js");
fs.writeFileSync(stub, "export const getCloudflareContext = () => { throw new Error('not in Cloudflare'); };\n");
const out = path.join(tmp, "bundle.mjs");
await build({
  entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
  tsconfig: path.join(ROOT, "tsconfig.json"),
  alias: { "server-only": stub, "@opennextjs/cloudflare": stub },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

process.env.KOTSUKOTSU_RUNTIME = "node";
const DB = openD1(":memory:");
await applyMigrations(DB, path.join(ROOT, "d1-migrations"), fs, path);
globalThis.__KOTSUKOTSU_ENV = { DB };
const mod = await import(pathToFileURL(out).href);

// 顧客の箱 (担当外) → 担当のタスク T1 (一番下) / T2 → その下の U
const ws = "ws-test";
const email = "yamada@example.test";
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const exec = (sql, ...a) => DB.prepare(sql).bind(...a).run();
await exec("INSERT INTO workspaces (id, name) VALUES (?, ?)", ws, "テスト");
await exec("INSERT INTO members (id, name, role, email, workspace_id) VALUES ('m1', '山田太郎', 'Member', ?, ?)", email, ws);
const goal = (id, name, parent, extra = {}) =>
  exec(
    `INSERT INTO projects (id, name, parent_goal_id, workspace_id, status, current_state, today_date, stalled_at, stalled_note)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    id, name, parent, ws, extra.state ?? "", extra.today ?? null, extra.stalled ?? null, extra.stalled ? "止まっている" : null
  );
const BALL = "2026-11-05時点\nボール: 山田太郎\n照合 PASS";
await goal("box", "見えてはいけない顧客", null);
await goal("t1", "担当のタスク1", "box", { state: BALL, today, stalled: "2026-11-01T00:00:00Z" });
await goal("t2", "担当のタスク2", "box");
await goal("u", "配下のタスク", "t2", { state: BALL });
await exec("INSERT INTO goal_members (goal_id, member_id) VALUES ('t1', 'm1'), ('t2', 'm1')");

const SECRET = "見えてはいけない顧客";
const results = [];
const check = (id, ok, note = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${note ? "  — " + note : ""}`);
};
const leaks = (v) => JSON.stringify(v).includes(SECRET);

const viewer = { email, name: "山田太郎" };
const member = { admin: false, scopeGoalId: null };
const admin = { admin: true, scopeGoalId: null };

// ---- Web ----
const myTasks = await mod.listMyAssignedItems(viewer, ws, member);
check("web my-tasks: 担当の根の親は名前を出さない", myTasks.length === 2 && !leaks(myTasks), JSON.stringify(myTasks.map((r) => [r.id, r.parent_name, r.parent_emoji])));
const myTasksAdmin = await mod.listMyAssignedItems(viewer, ws, admin);
check("web my-tasks: 管理者には親の名前を出す", myTasksAdmin.some((r) => r.parent_name === SECRET));
const myTurn = await mod.listMyTurn(viewer, ws, member);
check("web my-turn: 根の親は隠し、範囲の中の親は出す",
  !leaks(myTurn) && myTurn.find((r) => r.id === "u")?.parent_name === "担当のタスク2" && myTurn.some((r) => r.id === "t1"),
  JSON.stringify(myTurn.map((r) => [r.id, r.parent_name])));
check("web my-turn: 管理者には親の名前を出す", (await mod.listMyTurn(viewer, ws, admin)).some((r) => r.parent_name === SECRET));
const att = await mod.listAttention(viewer, ws, member);
check("web attention: 根の親は名前を出さない", (att.closable.length + att.stalled.length) > 0 && !leaks(att), JSON.stringify(att));
const attScoped = await mod.listAttention(viewer, ws, { admin: false, scopeGoalId: "t1" });
check("web attention (招待の範囲): 範囲の根の親は名前を出さない", attScoped.stalled.length > 0 && !leaks(attScoped));
check("web attention: 管理者には親の名前を出す", leaks(await mod.listAttention(viewer, ws, admin)));

// ---- MCP ----
const env = { DB };
const scoped = { wsId: ws, scopeRoots: ["t1", "t2"], actor: { userId: "u1", name: "山田太郎", email, role: "member" } };
const full = { wsId: ws, scopeRoots: null, actor: { userId: "u1", name: "山田太郎", email, role: "admin" } };
const ctx = { workspaceGiven: true };
const t = mod.todayTools;
const mTasks = await t.list_my_tasks.handler({}, env, ws, scoped, ctx);
check("mcp list_my_tasks: 根の親は名前を出さない", mTasks.items.length > 0 && !leaks(mTasks), JSON.stringify(mTasks.items.map((r) => [r.id, r.parent_name])));
check("mcp list_my_tasks: 管理者には親の名前を出す", leaks(await t.list_my_tasks.handler({}, env, ws, full, ctx)));
const mTurn = await t.list_my_turn.handler({}, env, ws, scoped, ctx);
check("mcp list_my_turn: 根の親は隠し、範囲の中の親は出す",
  !leaks(mTurn) && mTurn.items.find((r) => r.id === "u")?.parent_name === "担当のタスク2",
  JSON.stringify(mTurn.items.map((r) => [r.id, r.parent_name])));
const mToday = await t.list_today.handler({ date: today }, env, ws, scoped, ctx);
check("mcp list_today: 根の親は名前を出さない", mToday.items.length > 0 && !leaks(mToday), JSON.stringify(mToday.items.map((r) => [r.id, r.project_name])));
check("mcp list_today: 管理者には親の名前を出す", leaks(await t.list_today.handler({ date: today }, env, ws, full, ctx)));
const st = await mod.statusReport(env, ws, scoped, "");
const paths = JSON.stringify(st).match(/"path":\[[^\]]*\]/g) ?? [];
check("mcp status_report: path は範囲の中だけ", paths.length > 0 && !leaks(st) && JSON.stringify(st).includes('"path":["担当のタスク2"]'), paths.join(" "));
check("mcp status_report: 管理者には上の名前を出す", leaks(await mod.statusReport(env, ws, full, "")));

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} 件 FAIL` : "\n全部 PASS");
process.exit(failed ? 1 : 0);
