#!/usr/bin/env node
// 2026-11-05 セキュリティ点検の修正 (1eb864f8 / 4a1a00ff) を確かめる。
// - MCP: 招待の範囲も担当も無いメンバーは何も見えない (scopeRoots = [])
// - Web: GET /api/today・/api/members/[id]/goals・/api/templates/[id] が、メンバーには見える範囲のゴールだけ返す
// 手元の SQLite (node:sqlite, メモリ上) に d1-migrations を当て、本番のルートと関数をそのまま呼ぶ。
// ログインだけは差し替える (requireWorkspace が決めたメンバーを返す)。
//
// 使い方: node scripts/test-visibility-scope-1105.mjs
// 結果: 項目ごとに PASS / FAIL。FAIL が 1 つでもあれば exit 1。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { openD1, applyMigrations } from "../node-server/d1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kk-visibility-"));
const WS_MOD = path.join(ROOT, "app/lib/server/workspace.ts");

// ルートが読む workspace だけ、requireWorkspace を差し替えた写しにする (viewRoots などは本物)
const shim = path.join(tmp, "workspace-shim.ts");
fs.writeFileSync(shim, `export * from ${JSON.stringify(WS_MOD)};\nexport const requireWorkspace = async () => (globalThis as any).__CTX;\n`);
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, [
  `export { GET as todayGET } from ${JSON.stringify(path.join(ROOT, "app/api/today/route.ts"))};`,
  `export { GET as memberGoalsGET } from ${JSON.stringify(path.join(ROOT, "app/api/members/[id]/goals/route.ts"))};`,
  `export { GET as templateGET } from ${JSON.stringify(path.join(ROOT, "app/api/templates/[id]/route.ts"))};`,
  `export { membershipAuth, goalInScope, assertOwnMessage } from ${JSON.stringify(path.join(ROOT, "mcp-worker/src/lib.ts"))};`,
  `export { templatesTools } from ${JSON.stringify(path.join(ROOT, "mcp-worker/src/tools/templates.ts"))};`,
].join("\n"));
const stub = path.join(tmp, "stub.js");
fs.writeFileSync(stub, "export const getCloudflareContext = () => { throw new Error('not in Cloudflare'); };\n");
const out = path.join(tmp, "bundle.mjs");
await build({
  entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
  tsconfig: path.join(ROOT, "tsconfig.json"),
  alias: { "server-only": stub, "@opennextjs/cloudflare": stub },
  plugins: [{
    name: "workspace-shim",
    setup(b) {
      b.onResolve({ filter: /lib\/server\/workspace$/ }, (a) => (a.importer.includes(`${path.sep}app${path.sep}api${path.sep}`) ? { path: shim } : undefined));
    },
  }],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

process.env.KOTSUKOTSU_RUNTIME = "node";
const DB = openD1(":memory:");
await applyMigrations(DB, path.join(ROOT, "d1-migrations"), fs, path);
globalThis.__KOTSUKOTSU_ENV = { DB };
const mod = await import(pathToFileURL(out).href);

const ws = "ws-test";
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const exec = (sql, ...a) => DB.prepare(sql).bind(...a).run();
await exec("INSERT INTO workspaces (id, name) VALUES (?, ?)", ws, "テスト");
// 山田 = 「担当」に付いたメンバー、新人 = 担当0件のメンバー、同僚 = 見えてはいけない所の担当
await exec("INSERT INTO members (id, name, role, email, workspace_id) VALUES ('m-yamada', '山田', 'Member', 'yamada@example.test', ?)", ws);
await exec("INSERT INTO members (id, name, role, email, workspace_id) VALUES ('m-new', '新人', 'Member', 'new@example.test', ?)", ws);
await exec("INSERT INTO members (id, name, role, email, workspace_id) VALUES ('m-peer', '同僚', 'Member', 'peer@example.test', ?)", ws);
await exec("INSERT INTO templates (id, workspace_id, name, visibility, created_at, updated_at) VALUES ('tpl', ?, '型', 'workspace', '2026-11-05', '2026-11-05')", ws);
const goal = (id, name, parent, tpl = null) =>
  exec(`INSERT INTO projects (id, name, parent_goal_id, workspace_id, status, today_date, template_id) VALUES (?, ?, ?, ?, 'active', ?, ?)`, id, name, parent, ws, today, tpl);
await goal("mine", "担当の箱", null, "tpl");
await goal("mine-t", "担当のタスク", "mine");
await goal("secret", "見えてはいけない顧客", null, "tpl");
await goal("secret-t", "見えてはいけないタスク", "secret");
await exec("INSERT INTO goal_members (goal_id, member_id) VALUES ('mine', 'm-yamada')");
await exec("INSERT INTO goal_members (goal_id, member_id) VALUES ('secret', 'm-peer')");

const user = (id, email) => ({ id, email, name: id });
const ctxOf = (email) => ({ workspaceId: ws, role: "member", scopeGoalId: null, user: user(email, email) });
const req = (url) => new Request(`http://local${url}`);
const names = (rows) => rows.map((r) => `${r.id ?? ""}:${r.name ?? ""}`).join(",");

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (${detail})`}`); if (!ok) fail++; };

// MCP
const authNew = await mod.membershipAuth({ DB }, { workspace_id: ws, user_id: "u-new", role: "member", scope_goal_id: null, name: "新人", email: "new@example.test" });
check("MCP: 担当0件のメンバーの範囲は空 (全体ではない)", Array.isArray(authNew.scopeRoots) && authNew.scopeRoots.length === 0, JSON.stringify(authNew.scopeRoots));
check("MCP: 担当0件のメンバーに顧客の箱は見えない", !(await mod.goalInScope({ DB }, authNew, "secret")), "見えた");
const authAdmin = await mod.membershipAuth({ DB }, { workspace_id: ws, user_id: "u-admin", role: "admin", scope_goal_id: null, name: "管理者", email: "admin@example.test" });
check("MCP: 管理者は今までどおり全体", authAdmin.scopeRoots === null, JSON.stringify(authAdmin.scopeRoots));

// Web: today
globalThis.__CTX = ctxOf("yamada@example.test");
const t = await (await mod.todayGET(req(`/api/today?date=${today}`))).json();
check("Web today: 山田に担当外の今日は出ない", !names(t).includes("secret"), names(t));
check("Web today: 山田に自分の担当の今日は出る", names(t).includes("mine"), names(t));
globalThis.__CTX = ctxOf("new@example.test");
const t2 = await (await mod.todayGET(req(`/api/today?date=${today}`))).json();
check("Web today: 担当0件のメンバーには何も出ない", t2.length === 0, names(t2));

// Web: 同僚の担当
globalThis.__CTX = ctxOf("yamada@example.test");
const mg = await (await mod.memberGoalsGET(req("/api/members/m-peer/goals"), { params: Promise.resolve({ id: "m-peer" }) })).json();
check("Web 同僚の担当: 山田の見える範囲外は出ない", !names(mg).includes("secret"), names(mg));

// Web: 型から作ったゴール
const tr = await mod.templateGET(req("/api/templates/tpl"), { params: Promise.resolve({ id: "tpl" }) });
if (tr.status === 200) {
  const tj = await tr.json();
  check("Web 型の詳細: 見える範囲外のゴールは出ない", !names(tj.goals ?? []).includes("secret"), names(tj.goals ?? []));
  check("Web 型の詳細: 自分の担当のゴールは出る", names(tj.goals ?? []).includes("mine"), names(tj.goals ?? []));
} else {
  check("Web 型の詳細: 型が読める", false, `status ${tr.status}`);
}

// MCP get_file: 見られない型のファイルを、自分の型の名前を同じ id にして読めない
await exec("INSERT INTO templates (id, workspace_id, name, visibility, created_by, created_at, updated_at) VALUES ('priv-tpl', ?, '見られない型', 'private', 'u-other', '2026-11-05', '2026-11-05')", ws);
await exec("INSERT INTO templates (id, workspace_id, name, visibility, created_by, created_at, updated_at) VALUES ('my-tpl', ?, 'priv-tpl', 'private', 'u-yamada', '2026-11-05', '2026-11-05')", ws);
const authYamada = await mod.membershipAuth({ DB }, { workspace_id: ws, user_id: "u-yamada", role: "member", scope_goal_id: null, name: "山田", email: "yamada@example.test" });
const FILES = { get: async () => ({ size: 3, httpMetadata: { contentType: "application/pdf" }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) };
let readPriv = false;
try {
  await mod.templatesTools.get_file.handler({ key: `r2:${ws}/templates/priv-tpl/x.pdf` }, { DB, FILES }, ws, authYamada);
  readPriv = true;
} catch { /* 断られた */ }
check("MCP get_file: 見られない型のファイルは、名前を同じ id にした自分の型経由でも読めない", !readPriv, "読めた");
let readOwn = false;
try {
  await mod.templatesTools.get_file.handler({ key: `r2:${ws}/templates/my-tpl/x.pdf` }, { DB, FILES }, ws, authYamada);
  readOwn = true;
} catch { /* 断られた */ }
check("MCP get_file: 自分の型のファイルは読める", readOwn, "読めない");

// MCP コメントの本人判定: メールが一致したときだけ
const tryOwn = (msg) => { try { mod.assertOwnMessage(authYamada, msg); return true; } catch { return false; } };
check("MCP コメント: 自分のメールの投稿は直せる", tryOwn({ author: "山田", author_email: "yamada@example.test" }), "断られた");
check("MCP コメント: 同じ表示名でメールの無い投稿は直せない", !tryOwn({ author: "山田", author_email: null }), "直せた");
check("MCP コメント: 退会したメンバーの投稿は直せない", !tryOwn({ author: "退会したメンバー", author_email: null }), "直せた");

console.log(fail ? `\n${fail} 件 FAIL` : "\n全部 PASS");
process.exit(fail ? 1 : 0);
