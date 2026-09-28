// こつこつの Docker 版 (Cloudflare を使わずに、どこでも動かす版) のサーバー。
//
// Cloudflare 版では3つの Worker (本体・リアルタイム・MCP) と D1・R2 で動いているものを、
// この1プロセスがまとめて受け持つ。
//
//   - 画面・API        … Next.js (next start と同じ)
//   - /mcp と OAuth    … mcp-worker をそのまま Node で動かす (node-server/dist/mcp.mjs)
//   - /ws              … リアルタイム配信 (Durable Object の代わりに WebSocket サーバー)
//   - データベース     … DATA_DIR/kotsukotsu.sqlite (D1 と同じ呼び方で使える包みを env.DB に渡す)
//   - ファイル置き場   … DATA_DIR/files/ (R2 と同じ呼び方の包みを env.FILES に渡す)
//   - 期限リマインダ   … 5分ごとに mcp-worker の scheduled を呼ぶ (Cloudflare の Cron の代わり)
//
// 起動時に d1-migrations/ のうち、まだ当てていないものだけを当てる (データは消さない)。
// 設定は環境変数 (.env)。docs/self-hosting-docker.md を参照。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { openD1, applyMigrations } from "./d1.mjs";
import { fileBucket } from "./r2.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const INTERNAL = `http://127.0.0.1:${PORT}`;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`環境変数 ${name} がありません。npm run setup:docker で .env を作ってください。`);
    process.exit(1);
  }
  return v;
}

// ---- データ ----
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB = openD1(path.join(DATA_DIR, "kotsukotsu.sqlite"));
const applied = await applyMigrations(DB, path.join(ROOT, "d1-migrations"), fs, path);
if (applied.length) console.log(`マイグレーションを当てました: ${applied.join(", ")}`);
const FILES = fileBucket(path.join(DATA_DIR, "files"));

// ---- リアルタイム (ワークスペースごとの部屋) ----
const rooms = new Map();
function broadcast(wsId) {
  const msg = JSON.stringify({ t: "changed" });
  for (const s of rooms.get(wsId) ?? []) {
    try { s.send(msg); } catch { /* 切れた接続 */ }
  }
}

// ---- アプリと MCP に渡す env (Cloudflare の Worker の env と同じ形) ----
const RT_SECRET = need("RT_SECRET");
const env = {
  APP_ENV: "production",
  DB,
  FILES,
  // リアルタイム: Cloudflare では別 Worker への service binding。ここでは同じプロセスで配る
  RT_URL: "http://realtime.internal",
  RT_SECRET,
  RT: {
    async fetch(input, init) {
      const req = new Request(input, init);
      const u = new URL(req.url);
      if (req.headers.get("x-rt-secret") !== RT_SECRET) return new Response("forbidden", { status: 403 });
      if (u.pathname === "/notify") broadcast(u.searchParams.get("ws") ?? "");
      return new Response("ok");
    },
  },
  // MCP → 本体 (Push 送信・自己診断) は、同じサーバーの API を内側から呼ぶ
  PUSH_URL: INTERNAL,
  PUSH_SECRET: need("PUSH_SECRET"),
  APP: {
    fetch(input, init) {
      const req = new Request(input, init);
      const u = new URL(req.url);
      return fetch(new Request(INTERNAL + u.pathname + u.search, req));
    },
  },
  VAPID_PUBLIC_KEY: need("VAPID_PUBLIC_KEY"),
  VAPID_PRIVATE_KEY: need("VAPID_PRIVATE_KEY"),
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  MCP_TOKEN: need("MCP_TOKEN"),
  OAUTH_SECRET: need("OAUTH_SECRET"),
  SIGNUP_MODE: process.env.SIGNUP_MODE || "invite",
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  MAIL_FROM: process.env.MAIL_FROM,
};
globalThis.__KOTSUKOTSU_ENV = env;

// Cloudflare の ExecutionContext の代わり。Node ではプロセスが生きているのでそのまま走らせる
const ctx = { waitUntil: (p) => { Promise.resolve(p).catch((e) => console.error(e)); }, passThroughOnException() {} };

// ---- 起動 ----
const nextApp = next({ dev: false, dir: ROOT, hostname: "localhost", port: PORT });
const handleNext = nextApp.getRequestHandler();
await nextApp.prepare();
const mcp = (await import("./dist/mcp.mjs")).default;

// mcp-worker と同じ振り分け (Cloudflare 版では pages-proxy がやっている)
const isMcpPath = (p) =>
  p === "/mcp" || p.startsWith("/mcp/") ||
  p.startsWith("/.well-known/oauth-") || p.startsWith("/.well-known/openid-configuration") ||
  p === "/register" || p === "/authorize" || p === "/token";

// 外から見たアドレス (OAuth の戻り先などに使う)。リバースプロキシ (Caddy など) の後ろでは X-Forwarded-* を見る
function originOf(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

async function toFetchRequest(req) {
  const url = originOf(req) + req.url;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: "half" });
}

async function sendFetchResponse(res, r) {
  const headers = {};
  r.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
  const cookies = r.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(r.status, headers);
  if (r.body) for await (const chunk of r.body) res.write(chunk);
  res.end();
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || "/").split("?")[0];
  try {
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (isMcpPath(pathname)) {
      return await sendFetchResponse(res, await mcp.fetch(await toFetchRequest(req), env, ctx));
    }
    // 画面・API 側が作る URL (招待リンク・再設定リンクなど) を、外から見たアドレスにする
    const o = new URL(originOf(req));
    req.headers["x-forwarded-host"] = o.host;
    req.headers["x-forwarded-proto"] = o.protocol.replace(":", "");
    await handleNext(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end("internal error");
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url || "/", "http://x");
  if (u.pathname !== "/ws") return socket.destroy();
  const wsId = u.searchParams.get("ws") || "";
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!rooms.has(wsId)) rooms.set(wsId, new Set());
    rooms.get(wsId).add(ws);
    // 端末からの "changed" (画面での編集) は同じ部屋の全員へ。"ping" には "pong"
    ws.on("message", (m) => {
      const s = m.toString();
      if (s === "ping") return ws.send("pong");
      if (s === "changed") broadcast(wsId);
    });
    ws.on("close", () => rooms.get(wsId)?.delete(ws));
  });
});

// 期限リマインダ・毎日の自己診断 (Cloudflare の Cron "*/5 * * * *" の代わり)
const tick = () => {
  const now = Date.now();
  Promise.resolve(mcp.scheduled({ cron: "*/5 * * * *", scheduledTime: now }, env, ctx)).catch((e) => console.error("scheduled:", e));
};
setInterval(tick, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`こつこつ (Docker 版) を起動しました: ポート ${PORT}、データ ${DATA_DIR}`));

// docker compose stop などで止めるとき、DB をきちんと閉じる (書きかけ (WAL) を本体に書き戻す)。
// 閉じずに止めると、バックアップを戻したときに残った WAL と食い違うことがある。
let closing = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`${sig} を受けたので止めます`);
    server.close();
    for (const s of wss.clients) s.terminate();
    try { DB._raw.exec("PRAGMA wal_checkpoint(TRUNCATE)"); DB._raw.close(); } catch (e) { console.error(e); }
    process.exit(0);
  });
}
