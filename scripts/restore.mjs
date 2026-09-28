#!/usr/bin/env node
// Docker 版のデータベースを、npm run update が取ったバックアップの時点に戻す。
//
//   npm run restore                                   # 一番新しいバックアップに戻す
//   npm run restore -- backups/kotsukotsu-<日時>.sqlite  # 指定したバックアップに戻す
//
// 戻す前に、今のデータベースも backups/ に退避する (戻したあとで「やっぱり戻す前がよかった」に備える)。
// Cloudflare 版は D1 の Time Travel で戻す (docs/self-hosting.md)。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const log = (msg) => console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};
const docker = (args) => spawnSync("docker", args, { cwd: ROOT, stdio: "inherit", shell: IS_WIN }).status ?? 1;

const stateFile = path.join(ROOT, ".setup.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
if (state.platform !== "docker") fail("npm run restore は Docker 版用です。Cloudflare 版は docs/self-hosting.md の「更新が失敗したとき」を見てください。");

const dir = path.join(ROOT, "backups");
const given = process.argv.slice(2).find((a) => !a.startsWith("--"));
// 指定が無ければ、npm run update が取った中で一番新しいもの (before-restore-* は選ばない)
const backups = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("kotsukotsu-") && f.endsWith(".sqlite")).sort() : [];
const file = given ? path.resolve(ROOT, given) : backups.length ? path.join(dir, backups[backups.length - 1]) : null;
if (!file || !existsSync(file)) fail(given ? `${given} が見つかりません` : "backups/ にバックアップがありません");
console.log(`戻す先: ${path.relative(ROOT, file)}`);

log("今のデータベースを退避します");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const inner = `/data/before-restore-${stamp}.sqlite`;
const vacuum = `const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/kotsukotsu.sqlite').exec("VACUUM INTO '${inner}'")`;
if (docker(["compose", "exec", "-T", "kotsukotsu", "node", "--disable-warning=ExperimentalWarning", "-e", vacuum]) !== 0) {
  fail("今のデータベースを退避できなかったので止めました (何も変えていません)");
}
docker(["compose", "cp", `kotsukotsu:${inner}`, path.join("backups", `before-restore-${stamp}.sqlite`)]);
docker(["compose", "exec", "-T", "kotsukotsu", "rm", "-f", inner]);

log("止めて、バックアップを戻します");
if (docker(["compose", "stop", "kotsukotsu"]) !== 0) fail("止められませんでした");
if (docker(["compose", "cp", file, "kotsukotsu:/data/kotsukotsu.sqlite"]) !== 0) fail("バックアップを戻せませんでした");
// docker compose cp で入れたファイルは root のものになる。アプリ (node ユーザー) が書けるよう持ち主を直し、
// 古い書きかけ (WAL) を消す
if (docker(["compose", "run", "--rm", "--no-deps", "--user", "root", "--entrypoint", "sh", "kotsukotsu", "-c",
  "chown node:node /data/kotsukotsu.sqlite && rm -f /data/kotsukotsu.sqlite-wal /data/kotsukotsu.sqlite-shm"]) !== 0) {
  fail("戻したファイルの持ち主を直せませんでした");
}

log("起動します");
if (docker(["compose", "start", "kotsukotsu"]) !== 0) fail("起動できませんでした");
const port = state.port ?? "3000";
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  try { ok = (await fetch(`http://localhost:${port}/healthz`)).ok; } catch { /* まだ */ }
  if (!ok) await new Promise((r) => setTimeout(r, 2000));
}
if (!ok) fail("起動を確認できませんでした。docker compose logs kotsukotsu を見てください。");
console.log(`\n\x1b[32m✓ ${path.relative(ROOT, file)} の時点に戻しました\x1b[0m (戻す前のデータ: backups/before-restore-${stamp}.sqlite)`);
