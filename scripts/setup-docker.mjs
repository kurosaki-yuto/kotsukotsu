#!/usr/bin/env node
// こつこつを Docker で立ち上げる (Cloudflare を使わない版)。Docker が動く所ならどこでもよい。
//
//   npm run setup:docker                                  # このパソコンだけで使う (http://localhost:3000)
//   npm run setup:docker -- --domain tasks.example.com    # 独自ドメインで HTTPS 公開 (サーバー向け)
//
// やること (何度実行しても同じ結果になる):
//   1. Docker と docker compose があるか確かめる
//   2. 鍵とシークレットを作って .env に書く (既にあれば使い回す。.gitignore 済み)
//   3. イメージをビルドして起動する。データは Docker のボリューム (kotsukotsu-data) に残る
//   4. 起動を待って URL を表示する
//
// 独自ドメインで公開するときは、先にそのドメインの DNS (A レコード) をこのサーバーの IP に向け、
// 80 番と 443 番を開けておく。証明書は Caddy が自動で取る。
// 立ち上げが最後まで終わったら、提供元に「1件立ち上がった」とだけ知らせる (setup.mjs と同じ。--no-telemetry で止まる)。

import { execSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
const STATE_FILE = path.join(ROOT, ".setup.json");
const IS_WIN = process.platform === "win32";

const log = (msg) => console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const run = (args, opts = {}) => spawnSync("docker", args, { cwd: ROOT, stdio: "inherit", shell: IS_WIN, ...opts }).status ?? 1;

// ---- 1. Docker ----
log("Docker を確認します");
if (spawnSync("docker", ["compose", "version"], { stdio: "ignore", shell: IS_WIN }).status !== 0) {
  fail("Docker (docker compose) が見つかりません。Docker Desktop か Docker Engine を入れてから、もう一度実行してください。");
}
if (spawnSync("docker", ["info"], { stdio: "ignore", shell: IS_WIN }).status !== 0) {
  fail("Docker が起動していません。Docker Desktop を起動してから、もう一度実行してください。");
}

// ---- 2. .env ----
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
if (state.platform && state.platform !== "docker") {
  fail("このフォルダは Cloudflare 版として立ち上げ済みです。Docker 版は別のフォルダに clone し直してください。");
}
const domain = argValue("--domain") ?? state.domain ?? null;
if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) fail(`ドメイン「${domain}」の形が正しくありません (例: tasks.example.com)`);
const port = argValue("--port") ?? state.port ?? "3000";

log(".env を用意します");
const existing = {};
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) existing[m[1]] = m[2];
  }
}
const secret = () => randomBytes(32).toString("hex");
let vapid = null;
if (!existing.VAPID_PUBLIC_KEY || !existing.VAPID_PRIVATE_KEY) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  vapid = {
    pub: Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]).toString("base64url"),
    priv: privateKey.export({ format: "jwk" }).d,
  };
}
const env = {
  RT_SECRET: existing.RT_SECRET ?? secret(),
  PUSH_SECRET: existing.PUSH_SECRET ?? secret(),
  MCP_TOKEN: existing.MCP_TOKEN ?? secret(),
  OAUTH_SECRET: existing.OAUTH_SECRET ?? secret(),
  VAPID_PUBLIC_KEY: existing.VAPID_PUBLIC_KEY ?? vapid.pub,
  VAPID_PRIVATE_KEY: existing.VAPID_PRIVATE_KEY ?? vapid.priv,
  VAPID_SUBJECT: existing.VAPID_SUBJECT ?? "mailto:admin@example.com",
  // 最初の1人 (管理者) 以外は招待リンクからしか登録できない。誰でも登録させるなら open
  SIGNUP_MODE: existing.SIGNUP_MODE ?? "invite",
  BASE_URL: domain ? `https://${domain}` : `http://localhost:${port}`,
  DOMAIN: domain ?? "",
  PORT: port,
  RESEND_API_KEY: existing.RESEND_API_KEY ?? "",
  MAIL_FROM: existing.MAIL_FROM ?? "",
};
writeFileSync(
  ENV_FILE,
  "# npm run setup:docker が作った設定。鍵が入っているので共有・コミットしない\n" +
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  { mode: 0o600 },
);
Object.assign(state, {
  platform: "docker",
  domain,
  port,
  installId: state.installId ?? randomBytes(16).toString("hex"),
});
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

// ---- 3. 起動 ----
log("ビルドして起動します。初回は数分かかります");
const compose = ["compose", ...(domain ? ["--profile", "https"] : []), "up", "-d", "--build"];
if (run(compose) !== 0) fail("docker compose up が失敗しました");

// ---- 4. 起動待ち ----
log("起動を待ちます");
const local = `http://localhost:${port}`;
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  try {
    ok = (await fetch(`${local}/healthz`)).ok;
  } catch { /* まだ */ }
  if (!ok) await new Promise((r) => setTimeout(r, 2000));
}
if (!ok) fail("起動を確認できませんでした。docker compose logs kotsukotsu でログを見てください。");

// ---- 立ち上げ完了の通知 (乱数の ID と版だけ) ----
if (!process.argv.includes("--no-telemetry") && !process.env.KOTSUKOTSU_NO_TELEMETRY) {
  let version = null;
  try { version = execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* git なし */ }
  try {
    await fetch("https://stats.kotukotu.app/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: state.installId, version }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* 届かなくても何もしない */ }
}

console.log(`
\x1b[32m✓ できました (Docker 版)\x1b[0m

  こつこつ     ${env.BASE_URL}
  AI 接続 (MCP) ${env.BASE_URL}/mcp   (設定 → APIキー にキー入りの URL が出る)

次にやること:
  1. 上の URL を開いて「新規登録」から最初のアカウントを作る (その人が管理者になる)
  2. 仲間は 設定 → 招待リンク から招く
  3. Claude から使うときは 設定 → APIキー の接続 URL を claude.ai のコネクタに貼る
${domain ? "" : "\n  このパソコンの外から使うときは、サーバーで npm run setup:docker -- --domain <ドメイン> を実行する\n"}
鍵は .env に入っています (.gitignore 済み。なくさない・共有しない)。データは Docker のボリューム kotsukotsu-data にあります。
最新にするときは npm run update。
`);
