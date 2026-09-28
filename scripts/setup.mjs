#!/usr/bin/env node
// こつこつを自分の Cloudflare アカウントに立ち上げる。
//
//   npm install
//   npm run setup
//
// やること (何度実行しても同じ結果になる):
//   1. Cloudflare にログインしているか確かめる (していなければ wrangler login を開く)
//   2. D1 データベースを作ってテーブルを作る
//   3. R2 バケットを作る (R2 を有効にしていないアカウントなら、ファイル添付なしで進める)
//   4. 鍵とシークレットを作る (.setup.json に保存。再実行しても同じ値を使う)
//   5. リアルタイム → 本体 → MCP の順に 3 つの Worker をデプロイしてシークレットを入れる
//   6. 本体の URL を表示する
//
// 生成したシークレットは .setup.json と .dev.vars にだけ書く (どちらも .gitignore 済み)。

import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, ".setup.json");
const DB_NAME = "kotsukotsu-db";
const BUCKET = "kotsukotsu-files";
const APP_CONFIG = "wrangler.jsonc";
const MCP_CONFIG = "mcp-worker/wrangler.jsonc";
const RT_CONFIG = "realtime-worker/wrangler.jsonc";
// YOUR_SUBDOMAIN などの目印が入っているファイル
const PLACEHOLDER_FILES = [APP_CONFIG, MCP_CONFIG, "app/lib/series.ts", "mcp-worker/src/index.ts"];
const IS_WIN = process.platform === "win32";

const log = (msg) => console.log(`\n\x1b[1m▶ ${msg}\x1b[0m`);
const warn = (msg) => console.log(`\x1b[33m! ${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

/** コマンドを実行する。出力はそのまま画面に流しつつ、capture なら文字列でも返す。 */
function run(cmd, args, { capture = false, allowFail = false, env = {}, cwd = ROOT, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: IS_WIN,
      stdio: ["inherit", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    let out = "";
    if (capture) {
      child.stdout.on("data", (d) => { out += d; if (!quiet) process.stdout.write(d); });
      child.stderr.on("data", (d) => { out += d; if (!quiet) process.stderr.write(d); });
    }
    child.on("close", (code) => {
      if (code !== 0 && !allowFail) fail(`${cmd} ${args.join(" ")} が失敗しました (終了コード ${code})`);
      resolve({ code, out });
    });
  });
}

const wrangler = (args, opts) => run(IS_WIN ? "npx.cmd" : "npx", ["wrangler", ...args], opts);

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}
function write(rel, text) {
  writeFileSync(path.join(ROOT, rel), text);
}
function replaceIn(rel, from, to) {
  const text = read(rel);
  if (text.includes(from)) write(rel, text.split(from).join(to));
}

const secret = () => randomBytes(32).toString("hex");

/** Web Push 用の鍵 (P-256)。公開鍵は非圧縮点、秘密鍵はスカラーを base64url で。 */
function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return { publicKey: point.toString("base64url"), privateKey: priv.d };
}

function loadState() {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  // 目印が無い = 既に誰かの本番の値が入った設定。上書きしてデプロイすると事故になるので止める。
  if (!read(APP_CONFIG).includes("YOUR_D1_DATABASE_ID") && !process.argv.includes("--force")) {
    fail(
      `${APP_CONFIG} は既に設定済みです (YOUR_D1_DATABASE_ID の目印がありません)。\n` +
      "  このまま進めるとその環境のシークレットを作り直します。本当に進めるなら --force を付けてください。",
    );
  }
  const vapid = vapidKeys();
  return {
    secrets: {
      RT_SECRET: secret(),
      PUSH_SECRET: secret(),
      MCP_TOKEN: secret(),
      OAUTH_SECRET: secret(),
      SSO_SECRET: secret(),
      VAPID_PRIVATE_KEY: vapid.privateKey,
    },
    vapidPublicKey: vapid.publicKey,
  };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

async function putSecrets(config, values) {
  const dir = mkdtempSync(path.join(tmpdir(), "kotsukotsu-"));
  const file = path.join(dir, "secrets.json");
  writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  try {
    await wrangler(["secret", "bulk", file, "--config", config]);
  } finally {
    unlinkSync(file);
  }
}

function writeDevVars(rel, values) {
  const file = path.join(ROOT, rel);
  if (existsSync(file)) return;
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
}

async function chooseAccount(whoami) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = whoami.accounts ?? [];
  if (accounts.length === 0) fail("この Cloudflare ログインで使えるアカウントがありません");
  if (accounts.length === 1) return accounts[0].id;
  console.log("\nどのアカウントに作りますか？");
  accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.name} (${a.id})`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("番号: ");
  rl.close();
  const picked = accounts[Number(answer) - 1];
  if (!picked) fail("番号が正しくありません");
  return picked.id;
}

async function main() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) fail(`Node.js 20 以上が必要です (いまは ${process.versions.node})`);

  if (!existsSync(path.join(ROOT, "node_modules"))) {
    log("依存パッケージを入れます");
    await run(IS_WIN ? "npm.cmd" : "npm", ["install"]);
  }
  if (!existsSync(path.join(ROOT, "mcp-worker/node_modules"))) {
    log("MCP サーバーの依存パッケージを入れます");
    await run(IS_WIN ? "npm.cmd" : "npm", ["install"], { cwd: path.join(ROOT, "mcp-worker") });
  }

  log("Cloudflare のログインを確認します");
  let who = await wrangler(["whoami", "--json"], { capture: true, allowFail: true, quiet: true });
  if (who.code !== 0) {
    console.log("ブラウザで Cloudflare にログインしてください。");
    await wrangler(["login"]);
    who = await wrangler(["whoami", "--json"], { capture: true, quiet: true });
  }
  const whoami = JSON.parse(who.out.slice(who.out.indexOf("{")));
  const accountId = await chooseAccount(whoami);
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  console.log(`アカウント: ${accountId} (${whoami.email ?? "メール不明"})`);

  const state = loadState();
  state.accountId = accountId;
  saveState(state);

  log(`D1 データベース ${DB_NAME} を用意します`);
  const findDb = async () => {
    const { out } = await wrangler(["d1", "list", "--json"], { capture: true, quiet: true });
    const list = JSON.parse(out.slice(out.indexOf("[")));
    return list.find((d) => d.name === DB_NAME);
  };
  let db = await findDb();
  if (!db) {
    await wrangler(["d1", "create", DB_NAME]);
    db = await findDb();
  }
  if (!db) fail("D1 データベースの作成を確認できませんでした");
  console.log(`database_id: ${db.uuid}`);
  replaceIn(APP_CONFIG, "YOUR_D1_DATABASE_ID", db.uuid);
  replaceIn(MCP_CONFIG, "YOUR_D1_DATABASE_ID", db.uuid);

  log("テーブルを作ります (マイグレーション)");
  await wrangler(["d1", "migrations", "apply", DB_NAME, "--remote"], { env: { CI: "1" } });

  if (state.r2 === undefined) {
    log(`R2 バケット ${BUCKET} を用意します`);
    const r = await wrangler(["r2", "bucket", "create", BUCKET], { capture: true, allowFail: true });
    state.r2 = r.code === 0 || /already exists|already own/i.test(r.out);
    saveState(state);
  }
  if (!state.r2) {
    warn("R2 が使えないため、ファイル添付なしで進めます。");
    warn("あとで使うときは Cloudflare ダッシュボードで R2 を有効にし、.setup.json の \"r2\" を消して再実行してください。");
    for (const rel of [APP_CONFIG, MCP_CONFIG]) {
      write(rel, read(rel).replace(/^(\s*)(\{ "binding": "FILES")/m, "$1// R2 未設定のため無効: $2"));
    }
  } else {
    for (const rel of [APP_CONFIG, MCP_CONFIG]) {
      write(rel, read(rel).replace(/\/\/ R2 未設定のため無効: /, ""));
    }
  }

  log("リアルタイム配信の Worker (kotsukotsu-rt) をデプロイします");
  const rt = await wrangler(["deploy", "--config", RT_CONFIG], { capture: true });
  const m = rt.out.match(/https:\/\/kotsukotsu-rt\.([a-z0-9-]+)\.workers\.dev/);
  const subdomain = m?.[1] ?? state.subdomain;
  if (!subdomain) {
    fail(
      "workers.dev のサブドメインが分かりませんでした。\n" +
      "  Cloudflare ダッシュボード → Workers & Pages でサブドメインを登録してから、もう一度 npm run setup してください。",
    );
  }
  state.subdomain = subdomain;
  saveState(state);
  await putSecrets(RT_CONFIG, { RT_SECRET: state.secrets.RT_SECRET });

  for (const rel of PLACEHOLDER_FILES) replaceIn(rel, "YOUR_SUBDOMAIN", subdomain);
  replaceIn(APP_CONFIG, "YOUR_VAPID_PUBLIC_KEY", state.vapidPublicKey);
  if (whoami.email) replaceIn(APP_CONFIG, "mailto:you@example.com", `mailto:${whoami.email}`);

  log("本体 (kotsukotsu) をビルドしてデプロイします。数分かかります");
  await run(IS_WIN ? "npm.cmd" : "npm", ["run", "cf:typegen"]);
  await run(IS_WIN ? "npm.cmd" : "npm", ["run", "cf:deploy"]);
  const s = state.secrets;
  await putSecrets(APP_CONFIG, {
    RT_SECRET: s.RT_SECRET,
    PUSH_SECRET: s.PUSH_SECRET,
    VAPID_PRIVATE_KEY: s.VAPID_PRIVATE_KEY,
    SSO_SECRET: s.SSO_SECRET,
  });

  log("MCP サーバー (kotsukotsu-mcp) をデプロイします");
  await wrangler(["deploy", "--config", MCP_CONFIG]);
  await putSecrets(MCP_CONFIG, {
    RT_SECRET: s.RT_SECRET,
    PUSH_SECRET: s.PUSH_SECRET,
    MCP_TOKEN: s.MCP_TOKEN,
    OAUTH_SECRET: s.OAUTH_SECRET,
  });

  // ローカルで npm run dev するときの値 (既にあるファイルは触らない)
  writeDevVars(".dev.vars", {
    RT_SECRET: s.RT_SECRET,
    PUSH_SECRET: s.PUSH_SECRET,
    VAPID_PRIVATE_KEY: s.VAPID_PRIVATE_KEY,
    SSO_SECRET: s.SSO_SECRET,
  });
  writeDevVars("mcp-worker/.dev.vars", {
    RT_SECRET: s.RT_SECRET,
    PUSH_SECRET: s.PUSH_SECRET,
    MCP_TOKEN: s.MCP_TOKEN,
    OAUTH_SECRET: s.OAUTH_SECRET,
  });

  const app = `https://kotsukotsu.${subdomain}.workers.dev`;
  console.log(`
\x1b[32m✓ できました\x1b[0m

  こつこつ     ${app}
  AI 接続 (MCP) https://kotsukotsu-mcp.${subdomain}.workers.dev/mcp

次にやること:
  1. 上の URL を開いて「新規登録」から最初のアカウントを作る (その人がワークスペースの管理者になる)
  2. 仲間は 設定 → 招待リンク から招く
  3. Claude から使うときは 設定 → APIキー の接続 URL を claude.ai のコネクタに貼る

生成したシークレットは .setup.json に保存してあります (.gitignore 済み。なくさないこと)。
`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
