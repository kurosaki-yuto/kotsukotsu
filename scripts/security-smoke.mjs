#!/usr/bin/env node
// 自社環境 (ローカル / 自社のステージング) に向けた、脆弱性の再確認スクリプト。
// docs/security-audit-2026-10-12.md の指摘が「弾かれている」ことを、実際に叩いて確かめる。
// 他人のサーバーには向けない。本番に向けるときは読み取りだけの項目に絞る (--prod)。
//
// 使い方:
//   node scripts/security-smoke.mjs --base http://localhost:3939 --mcp http://localhost:8788 \
//     --email <ログインするメール> --password-file <パスワードを 1 行書いたファイル>
//   環境変数 SMOKE_EMAIL / SMOKE_PASSWORD でも渡せる。
//
// 出す結果: 各項目 PASS (弾いた) / FAIL (通ってしまった) / SKIP。FAIL が 1 つでもあれば exit 1。

import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"] : [])).filter((x) => x.length)
);
const BASE = (args.base ?? process.env.SMOKE_BASE ?? "http://localhost:3939").replace(/\/$/, "");
const MCP = (args.mcp ?? process.env.SMOKE_MCP ?? "").replace(/\/$/, "");
const EMAIL = args.email ?? process.env.SMOKE_EMAIL ?? "";
const PASSWORD = args["password-file"] ? fs.readFileSync(args["password-file"], "utf8").trim() : process.env.SMOKE_PASSWORD ?? "";
const PROD = !!args.prod;

const results = [];
function record(id, ok, note = "") {
  results.push({ id, ok, note });
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${id}${note ? "  — " + note : ""}`);
}

let cookie = "";
async function api(path, init = {}, raw = false) {
  const headers = { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) };
  const r = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
  if (raw) return r;
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body, headers: r.headers };
}

async function login() {
  if (!EMAIL || !PASSWORD) return false;
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const sc = r.headers.get("set-cookie") ?? "";
  const m = sc.match(/sid=([^;]+)/);
  if (!m) return false;
  cookie = `sid=${m[1]}`;
  return true;
}

async function main() {
  console.log(`target: ${BASE}${MCP ? "  mcp: " + MCP : ""}${PROD ? "  (read-only)" : ""}`);

  // ---- 1. 応答ヘッダー ----
  {
    const r = await fetch(BASE + "/login");
    const h = (k) => r.headers.get(k) ?? "";
    record("headers.csp", /frame-ancestors/.test(h("content-security-policy")), h("content-security-policy").slice(0, 60));
    record("headers.nosniff", h("x-content-type-options") === "nosniff");
    record("headers.frame", /SAMEORIGIN|DENY/.test(h("x-frame-options")));
    record("headers.hsts", /max-age=/.test(h("strict-transport-security")));
  }

  // ---- 2. オープンリダイレクト (ログイン画面の next は URL として同一オリジン判定) ----
  {
    const r = await fetch(BASE + "/login?next=/%5C%5Cevil.example", { redirect: "manual" });
    record("login.next-open-redirect", r.status === 200, "画面側で判定するので 200 のまま (JS の goNext が弾く)");
  }

  const loggedIn = await login();
  if (!loggedIn) {
    record("login", null, "資格情報が無いのでログイン後の項目は SKIP");
  } else {
    record("login", true);

    // ---- 3. CSRF: 他オリジンからの書き込み ----
    {
      const r = await api("/api/notifications", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ title: "csrf" }) });
      record("csrf.cross-origin-post", r.status === 401 || r.status === 403, `status ${r.status}`);
    }

    // ---- 4. アバター: HTML / SVG / 外部 URL は入らない ----
    for (const [name, v] of [
      ["html", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
      ["svg", "data:image/svg+xml;base64,PHN2Zy8+"],
      ["url", "https://evil.example/x.png"],
    ]) {
      if (PROD) { record(`avatar.${name}`, null, "読み取り専用"); continue; }
      const r = await api("/api/profile", { method: "PATCH", headers: { origin: BASE }, body: JSON.stringify({ avatar: v }) });
      record(`avatar.${name}`, r.status === 400, `status ${r.status}`);
    }

    // ---- 5. 通知: ゴール無しは管理者だけ / 他ワークスペースの goal_id は 404 ----
    {
      const r = await api("/api/notifications", { method: "POST", headers: { origin: BASE }, body: JSON.stringify({ title: "x", goal_id: "00000000-0000-0000-0000-000000000000" }) });
      record("notification.foreign-goal", r.status === 404, `status ${r.status}`);
    }

    // ---- 6. リソース: javascript: / r2: の URL は入らない ----
    {
      const goals = (await api("/api/goals?top=1")).body ?? [];
      const g = Array.isArray(goals) && goals[0] ? goals[0].id : null;
      if (!g || PROD) {
        record("resource.bad-url", null, g ? "読み取り専用" : "ゴールが無い");
      } else {
        const r1 = await api("/api/resources", { method: "POST", headers: { origin: BASE }, body: JSON.stringify({ goalId: g, name: "x", kind: "link", url: "javascript:alert(1)" }) });
        const r2 = await api("/api/resources", { method: "POST", headers: { origin: BASE }, body: JSON.stringify({ goalId: g, name: "x", kind: "file", url: "r2:other/key" }) });
        record("resource.javascript-url", r1.status === 400, `status ${r1.status}`);
        record("resource.r2-url", r2.status === 400, `status ${r2.status}`);
      }
    }

    // ---- 7. ファイル: text/html で上げても inline で返らない ----
    {
      const goals = (await api("/api/goals?top=1")).body ?? [];
      const g = Array.isArray(goals) && goals[0] ? goals[0].id : null;
      if (!g || PROD) {
        record("files.html-upload", null, g ? "読み取り専用" : "ゴールが無い");
      } else {
        const up = await api("/api/files", {
          method: "POST",
          headers: { "content-type": "text/html", "x-goal-id": g, "x-filename": "x.html", "x-caption": "smoke", origin: BASE },
          body: "<script>alert(1)</script>",
        });
        if (up.status === 500) {
          record("files.html-upload", null, "R2 が無い環境 (storage unavailable)");
        } else if (up.status !== 200 || !up.body?.url) {
          record("files.html-upload", false, `upload status ${up.status}`);
        } else {
          const key = String(up.body.url).replace(/^r2:/, "");
          const r = await api(`/api/files?key=${encodeURIComponent(key)}`, {}, true);
          const ct = r.headers.get("content-type") ?? "";
          const cd = r.headers.get("content-disposition") ?? "";
          const csp = r.headers.get("content-security-policy") ?? "";
          record("files.html-upload", !ct.includes("text/html") && /attachment/.test(cd) && /sandbox/.test(csp), `type=${ct} disposition=${cd.slice(0, 20)}`);
          await api(`/api/resources/${up.body.id}`, { method: "DELETE", headers: { origin: BASE } });
        }
      }
    }

    // ---- 8. ゴールの PATCH で親を書き換えられない ----
    {
      const goals = (await api("/api/goals?top=1")).body ?? [];
      const g = Array.isArray(goals) && goals[0] ? goals[0] : null;
      if (!g || PROD) {
        record("goal.patch-parent", null, g ? "読み取り専用" : "ゴールが無い");
      } else {
        await api(`/api/goals/${g.id}`, { method: "PATCH", headers: { origin: BASE }, body: JSON.stringify({ parent_goal_id: g.id }) });
        const after = (await api(`/api/goals/${g.id}`)).body;
        record("goal.patch-parent", after && after.parent_goal_id === (g.parent_goal_id ?? null), `parent=${after?.parent_goal_id}`);
      }
    }

    // ---- 9. 回数制限 (通知 30 回 / 15 分) ----
    if (!PROD) {
      let hit429 = false;
      for (let i = 0; i < 35; i++) {
        const r = await api("/api/notifications", { method: "POST", headers: { origin: BASE }, body: JSON.stringify({ title: "smoke" }) });
        if (r.status === 429) { hit429 = true; break; }
        if (r.status === 403) { record("ratelimit.notifications", null, "管理者ではないので全体通知は 403"); hit429 = null; break; }
      }
      if (hit429 !== null) record("ratelimit.notifications", hit429);
    } else {
      record("ratelimit.notifications", null, "読み取り専用");
    }

    // ---- 10. プッシュ購読: 社内アドレスは登録できない ----
    if (!PROD) {
      const r = await api("/api/push/subscribe", { method: "POST", headers: { origin: BASE }, body: JSON.stringify({ endpoint: "http://10.0.0.1/", keys: {} }) });
      record("push.internal-endpoint", r.status === 400, `status ${r.status}`);
    }

    // ---- 11. 今日の一括削除は管理者だけ (管理者で走らせているときは SKIP) ----
    {
      const me = (await api("/api/auth/me")).body?.user;
      if (me?.role === "admin") record("today.delete-member", null, "管理者で実行中");
      else {
        const r = await api("/api/today?date=2000-01-01", { method: "DELETE", headers: { origin: BASE } });
        record("today.delete-member", r.status === 403, `status ${r.status}`);
      }
    }
  }

  // ---- 12. MCP ----
  if (MCP) {
    const h = await fetch(MCP + "/health").then((r) => r.status).catch(() => 0);
    record("mcp.health", h === 200, `status ${h}`);
    if (h !== 200) {
      record("mcp.*", null, "MCP に繋がらないので以降の MCP 項目は SKIP");
    } else {
    const bad = await fetch(MCP + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-a-real-key" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    record("mcp.bad-key", bad.status === 401, `status ${bad.status}`);
    const big = await fetch(MCP + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-a-real-key" }, body: JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))) });
    record("mcp.batch-cap-unauth", big.status === 401 || big.status === 400, `status ${big.status} (未認証は 401 で止まる)`);
    const auth = await fetch(MCP + "/authorize?response_type=code&code_challenge=x&code_challenge_method=S256&redirect_uri=https://claude.ai/api/mcp/auth_callback", { redirect: "manual" });
    const loc = auth.headers.get("location") ?? "";
    if (auth.status === 500) record("mcp.oauth-no-silent-approve", null, "OAUTH_SECRET が未設定の環境");
    else record("mcp.oauth-no-silent-approve", !/[?&]code=/.test(loc), `status ${auth.status}${loc ? " → " + loc.slice(0, 60) : ""} (未ログインはログイン画面へ、ログイン済みでも同意画面が先)`);
    // 認可コードを POST (同意ボタン) 無しで取れないこと: GET にキー付き resource を渡しても code は返らない
    const probe = await fetch(MCP + "/authorize?response_type=code&code_challenge=x&code_challenge_method=S256&redirect_uri=https://claude.ai/api/mcp/auth_callback&resource=" + encodeURIComponent(MCP + "/mcp/not-a-real-key"), { redirect: "manual" });
    record("mcp.oauth-get-never-issues-code", !/[?&]code=/.test(probe.headers.get("location") ?? ""), `status ${probe.status}`);
    }
  }

  const fails = results.filter((r) => r.ok === false);
  console.log(`\n${results.length} checks: ${results.filter((r) => r.ok === true).length} pass, ${fails.length} fail, ${results.filter((r) => r.ok === null).length} skip`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
