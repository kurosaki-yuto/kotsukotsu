#!/usr/bin/env node
// 立ち上げ済みのこつこつを、データを消さずに最新版にする。
//
//   npm run update
//
// Cloudflare 版と Docker 版のどちらでも使える (.setup.json の platform で分ける)。Docker 版は下の updateDocker。
//
// やること:
//   1. setup が自社の値を書き込んだ設定ファイルを、いったん目印の状態に戻す
//      (戻さないと、こちらがそのファイルを更新したときに git pull がぶつかって止まる)
//   2. git pull で最新版を取る
//   3. 依存パッケージを入れ直す
//   4. データベースを丸ごとバックアップする (backups/ に .sql で保存。.gitignore 済み)
//   5. npm run setup を実行する: 保存済みの値 (.setup.json) を入れ直し、
//      まだ入っていないテーブル追加 (マイグレーション) だけを当てて、再デプロイする
//
// データは消えない。マイグレーションは足す変更だけにしてある (列やテーブルの削除はしない)。
// 万一おかしくなったら、4 のバックアップか、Cloudflare D1 の Time Travel で戻せる。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
// setup.mjs の PLACEHOLDER_FILES と同じ
const PLACEHOLDER_FILES = [
  "wrangler.jsonc", "mcp-worker/wrangler.jsonc", "realtime-worker/wrangler.jsonc",
  "app/lib/hosts.ts", "mcp-worker/src/index.ts", "package.json",
];

const log = (msg) => console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: IS_WIN, ...opts });
  return r.status ?? 1;
}
function out(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: IS_WIN });
  return { code: r.status ?? 1, text: (r.stdout ?? "") + (r.stderr ?? "") };
}
const npm = IS_WIN ? "npm.cmd" : "npm";
const npx = IS_WIN ? "npx.cmd" : "npx";

const stateFile = path.join(ROOT, ".setup.json");
if (!existsSync(stateFile)) fail("まだ立ち上げていません。先に npm run setup -- --name <名前> を実行してください。");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const isDocker = state.platform === "docker";
if (!isDocker && !state.name) fail(".setup.json に名前がありません。npm run setup -- --name <名前> を実行してください。");

// 自分で書き換えたファイルがあれば、上書きしないよう止める (setup が書き換えるファイルは除く)
const status = out("git", ["status", "--porcelain"]);
if (status.code !== 0) fail("git の状態を読めませんでした。git clone したフォルダで実行してください。");
const touched = status.text
  .split("\n")
  .filter((l) => l.startsWith(" M") || l.startsWith("M ") || l.startsWith("MM") || l.startsWith("A ") || l.startsWith("D "))
  .map((l) => l.slice(3).trim())
  .filter((f) => !PLACEHOLDER_FILES.includes(f));
if (touched.length && !process.argv.includes("--force")) {
  fail(
    "setup 以外で書き換えたファイルがあります。上書きしないよう止めました:\n" +
    touched.map((f) => `  ${f}`).join("\n") +
    "\n  コミットするか元に戻してから、もう一度実行してください (そのまま進めるなら --force)。",
  );
}

if (isDocker) {
  await updateDocker();
  process.exit(0);
}

log("設定ファイルを目印の状態に戻します (自社の値は .setup.json に保存されています)");
if (run("git", ["checkout", "--", ...PLACEHOLDER_FILES]) !== 0) fail("設定ファイルを戻せませんでした");

log("最新版を取り込みます (git pull)");
if (run("git", ["pull", "--ff-only"]) !== 0) {
  run("node", ["scripts/setup.mjs", "--configure-only"]);
  fail("git pull が止まりました。設定ファイルは元の値に戻してあります。内容を確認してから、もう一度実行してください。");
}

log("依存パッケージを入れ直します");
if (run(npm, ["install"]) !== 0) fail("npm install が失敗しました");
if (run(npm, ["install"], { cwd: path.join(ROOT, "mcp-worker") }) !== 0) fail("mcp-worker の npm install が失敗しました");

const env = { ...process.env, ...(state.accountId ? { CLOUDFLARE_ACCOUNT_ID: state.accountId } : {}) };
// バックアップはデータベースを設定ファイルから引くので、先に自社の値を入れ直しておく
if (run("node", ["scripts/setup.mjs", "--configure-only"], { env }) !== 0) fail("設定ファイルに自社の値を入れ直せませんでした");

log("データベースをバックアップします");
mkdirSync(path.join(ROOT, "backups"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = path.join("backups", `${state.name}-db-${stamp}.sql`);
if (run(npx, ["wrangler", "d1", "export", `${state.name}-db`, "--remote", "--output", backup], { env }) !== 0) {
  run("node", ["scripts/setup.mjs", "--configure-only"], { env });
  fail("バックアップが取れなかったので、更新を止めました (データはそのままです)。");
}
console.log(`保存しました: ${backup}`);

log("新しいテーブルだけ追加して、再デプロイします");
if (run("node", ["scripts/setup.mjs"], { env }) !== 0) {
  fail(`更新の途中で止まりました。データを戻すときは ${backup} を使えます (docs/self-hosting.md の「更新が失敗したとき」)。`);
}

console.log(`\n\x1b[32m✓ 最新版になりました\x1b[0m (バックアップ: ${backup})`);

// ---- Docker 版 ----
// Docker 版は設定ファイルを書き換えない (値は .env) ので、そのまま pull できる。
// データベースはコンテナの中で VACUUM INTO で1ファイルに書き出し (書き込み中でも崩れない)、backups/ へ持ち出す。
// 作り直して起動すると、server.mjs が足りないマイグレーションだけを当てる。
async function updateDocker() {
  const docker = (args, opts = {}) => run("docker", args, opts);
  const profile = state.domain ? ["--profile", "https"] : [];

  log("最新版を取り込みます (git pull)");
  if (run("git", ["pull", "--ff-only"]) !== 0) fail("git pull が止まりました。内容を確認してから、もう一度実行してください。");

  log("データベースをバックアップします");
  mkdirSync(path.join(ROOT, "backups"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const inner = `/data/backup-${stamp}.sqlite`;
  const backup = path.join("backups", `kotsukotsu-${stamp}.sqlite`);
  const vacuum = `const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/kotsukotsu.sqlite').exec("VACUUM INTO '${inner}'")`;
  if (docker(["compose", "exec", "-T", "kotsukotsu", "node", "--disable-warning=ExperimentalWarning", "-e", vacuum]) !== 0) {
    fail("バックアップが取れなかったので、更新を止めました (データはそのままです)。docker compose ps で起動しているか確かめてください。");
  }
  if (docker(["compose", "cp", `kotsukotsu:${inner}`, backup]) !== 0) fail("バックアップを取り出せなかったので、更新を止めました (データはそのままです)。");
  docker(["compose", "exec", "-T", "kotsukotsu", "rm", "-f", inner]);
  console.log(`保存しました: ${backup}`);

  log("作り直して起動します (足りないテーブルだけ追加されます)");
  if (docker(["compose", ...profile, "up", "-d", "--build"]) !== 0) {
    fail(`起動し直せませんでした。データを戻すときは ${backup} を使えます (docs/self-hosting-docker.md)。`);
  }
  const port = state.port ?? "3000";
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    try { ok = (await fetch(`http://localhost:${port}/healthz`)).ok; } catch { /* まだ */ }
    if (!ok) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ok) fail(`起動を確認できませんでした。docker compose logs kotsukotsu を見てください。バックアップ: ${backup}`);
  console.log(`\n\x1b[32m✓ 最新版になりました (Docker 版)\x1b[0m (バックアップ: ${backup})`);
}
