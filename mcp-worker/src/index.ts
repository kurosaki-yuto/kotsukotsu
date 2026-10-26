/**
 * Addness Todo — Remote MCP server (Cloudflare Worker).
 *
 * Lets an AI (Claude) operate the Addness todo app over MCP. Tools run SQL
 * against the SAME Cloudflare D1 database as the main app (binding `DB`,
 * database_name "kotsukotsu-db").
 *
 * Transport: MCP Streamable HTTP, implemented statelessly inside the Worker
 * `fetch` handler (one JSON-RPC request per POST -> one JSON response). Tool
 * input schemas are authored with zod (the schema lib the @modelcontextprotocol/sdk
 * uses) and converted to JSON Schema with `zod-to-json-schema`, so each tool's
 * advertised `inputSchema` matches the MCP wire spec exactly.
 *
 * Endpoints:
 *   POST /mcp     -> JSON-RPC (requires `Authorization: Bearer <MCP_TOKEN>`)
 *   GET  /health  -> { ok: true } (no auth)
 *   /.well-known/oauth-*, /register, /authorize, /token -> OAuth (src/oauth.ts)
 */

import { zodToJsonSchema } from "zod-to-json-schema";
// Same matcher the app uses for comment @mentions — one source of truth, so a
// name that notifies someone in the app notifies them through MCP too.
// 型 (誰かが終えたタスクのやり方) を、似たタスクを触る AI の返り値に添える。
import { rateLimited, rateLimitExceeded, claimOnce, shortHash } from "../../app/lib/server/ratelimitCore";
// claude.ai がキー無しURLで繋ぎに来た時の OAuth (動的クライアント登録) 経路。
import { handleOAuth, isOAuthPath, wwwAuthenticate } from "./oauth";

import { goalsTools } from "./tools/goals";
import { todayTools } from "./tools/today";
import { chatTools } from "./tools/chat";
import { miscTools } from "./tools/misc";
import { templatesTools } from "./tools/templates";
import { membersTools } from "./tools/members";
import { runDueReminders, runSelfCheck, isDailySelfCheckTick } from "./cron";
import { Env, MUTATING_TOOLS, PUSH_TOOLS } from "./env";
import { McpAuth, PushPayload, RPC, SUBTREE_CTE, ToolDef, authForWorkspace, corsHeaders, jsonResponse, notifyPush, notifyRealtime, reachableWorkspaces, resolveAuth, rpcError, rpcResult, toolText } from "./lib";
import { PROTOCOL_VERSION, SERVER_INFO, buildInstructions, instructionsAreStale, instructionsVersion, markInstructionsDelivered } from "./instructions";
// 顧客台帳 (kotsukotsu-crm) のツールを同じ接続に並べて取り次ぐ。MCP の接続先を1本にするため。
import { callCrmTool, crmInstructions, crmToolsList, isCrmTool } from "./crm";

const tools: Record<string, ToolDef> = { ...goalsTools, ...todayTools, ...chatTools, ...miscTools, ...templatesTools, ...membersTools };

const OWN_TOOLS = new Set(Object.keys(tools));

const TOOLS_LIST = Object.entries(tools).map(([name, def]) => {
  // Inline schema (no $ref wrapper) — MCP clients expect a self-contained object.
  const { $schema: _schema, ...inputSchema } = zodToJsonSchema(def.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  // Every tool (but list_workspaces) can target another workspace the person belongs to.
  if (name !== "list_workspaces") {
    inputSchema.properties = {
      ...(inputSchema.properties as Record<string, unknown> | undefined),
      workspace: {
        type: "string",
        description: "対象のワークスペース (id か名前)。省略時はこの接続の既定のワークスペース。一覧は list_workspaces",
      },
    };
  }
  return { name, description: def.description, inputSchema };
});

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

// JSON-RPC の生の要求。形は中で検査する
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRpc(message: any, env: Env, auth: McpAuth): Promise<unknown | null> {
  // Notifications (no id) -> no response.
  const isNotification = message.id === undefined || message.id === null;
  const { method, params, id } = message;
  const wsId = auth.wsId;
  // Observability: which JSON-RPC method (and tool) each caller invokes.
  console.log(`rpc method=${method}${method === "tools/call" ? ` tool=${params?.name}` : ""} ws=${wsId} actor=${auth.actor ? auth.actor.email ?? auth.actor.name : "ws-key"}`);

  switch (method) {
    case "initialize": {
      const instructions = buildInstructions(auth);
      // 顧客台帳の使い方は版の管理 (instructionsVersion) に入れない。顧客台帳側で直すたびに
      // 全接続に「運用ルールが更新されました」が出るのを避けるため。
      const withCrm = instructions + (await crmInstructions(env, auth));
      // The client is receiving them right here, so this connection is current.
      await markInstructionsDelivered(env, auth, instructionsVersion(instructions)).catch((err) => {
        console.log(`instruction delivery bookkeeping failed: ${(err as { message?: string })?.message ?? err}`);
      });
      return rpcResult(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: withCrm,
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // ack-only

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: [...TOOLS_LIST, ...(await crmToolsList(env, OWN_TOOLS, auth))] });

    case "tools/call": {
      const name = params?.name as string;
      const def = tools[name];
      if (!def) {
        if (!(await isCrmTool(env, name))) return rpcError(id, RPC.METHOD_NOT_FOUND, `unknown tool: ${name}`);
        // 顧客台帳のツール。どのワークスペースの本人として動くかはこちらで決めて渡す。
        try {
          const callAuth = await authForWorkspace(env, auth, params?.arguments?.workspace);
          return rpcResult(id, await callCrmTool(env, callAuth, name, params?.arguments ?? {}));
        } catch (err: unknown) {
          return rpcResult(id, {
            content: [{ type: "text", text: `Error: ${String((err as { message?: string })?.message ?? err)}` }],
            isError: true,
          });
        }
      }

      // `workspace` is shared by every tool, so it's not in the per-tool schemas
      // (z.object strips it during parse).
      const parsed = def.schema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return rpcError(id, RPC.INVALID_PARAMS, "invalid tool arguments", parsed.error.flatten());
      }
      try {
        const callAuth = name === "list_workspaces" ? auth : await authForWorkspace(env, auth, params?.arguments?.workspace);
        const wsId = callAuth.wsId;
        const wsArg = params?.arguments?.workspace;
        const result = await def.handler(parsed.data, env, wsId, callAuth, {
          workspaceGiven: typeof wsArg === "string" && wsArg.trim() !== "",
        });
        if (MUTATING_TOOLS.has(name)) await notifyRealtime(env, wsId);
        if (PUSH_TOOLS.has(name)) {
          // most PUSH_TOOLS take goalId directly; complete_subtask's id IS the
          // goal (subtasks are child goals), so fall back to the result's own id.
          const goalId =
            (parsed.data as { goalId?: string })?.goalId
            ?? (name === "complete_subtask" ? (result as { id?: string } | null)?.id ?? null : null)
            ?? (name === "apply_template" ? (result as { goal?: { id?: string } } | null)?.goal?.id ?? null : null);
          // Lock-screen payload mirroring the notification each handler just
          // inserted, so phones show real content even when logged out.
          let payload: PushPayload | null = null;
          const url = goalId ? `/goals/${goalId}` : "/notifications";
          if (name === "create_notification") {
            const n = result as { title?: string; body?: string | null } | null;
            if (n?.title) payload = { title: n.title, body: n.body ?? null, url };
          } else if (name === "complete_subtask") {
            const g = result as { name?: string | null; status?: string } | null;
            if (g?.status === "done" && g?.name) payload = { title: "完了", body: `「${g.name}」を完了しました`, url };
          } else if (name === "upload_file") {
            const r = result as { name?: string | null } | null;
            payload = { title: "ファイルが追加されました", body: r?.name ?? null, url };
          } else if (name === "apply_template") {
            const r = result as { template?: { name?: string }; goal?: { name?: string }; created?: number } | null;
            if (r?.template?.name) payload = { title: `型「${r.template.name}」のタスクが振られました`, body: `${r.goal?.name ?? ""} (${r.created ?? 0}件)`, url };
          }
          await notifyPush(env, wsId, goalId, undefined, payload);
        }
        const res = toolText(result);
        // Only when the rules actually changed since this caller last saw them.
        try {
          const instructions = buildInstructions(auth);
          const version = instructionsVersion(instructions);
          if (await instructionsAreStale(env, auth, version)) {
            await markInstructionsDelivered(env, auth, version);
            res.content.push({
              type: "text",
              text:
                "【こつこつ】運用ルールが更新されました。以降のこつこつ上の作業は、こちらの内容に沿って進めてください。\n\n" +
                instructions,
            });
          }
        } catch (err: unknown) {
          console.log(`instruction refresh skipped: ${(err as { message?: string })?.message ?? err}`);
        }
        return rpcResult(id, res);
      } catch (err: unknown) {
        // Tool execution error -> isError result (per MCP spec) so the model sees it.
        // D1 / 内部のエラーはそのまま出さない (テーブル名や SQL が外に漏れる)。
        const msg = String((err as { message?: string })?.message ?? err);
        const internal = /D1_|SQLITE|no such (table|column)|syntax error|near "/i.test(msg);
        if (internal) console.log(`tool ${name} internal error: ${msg}`);
        return rpcResult(id, {
          content: [{ type: "text", text: internal ? "Error: 内部エラーです。しばらくしてからやり直してください" : `Error: ${msg}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, RPC.METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

/**
 * ブラウザの こつこつ ログイン (本体と同じ cookie `sid` / sessions テーブル) から、その人の
 * いま開いているワークスペースでの APIキー (workspace_members.mcp_token) を返す。無ければ作る
 * (app/lib/server/queries.ts getMemberApiKey と同じ形式)。OAuth の承認に使う。
 */
async function memberKeyFromSession(req: Request, env: Env): Promise<string | null> {
  const sid = (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .map((p) => p.split("="))
    .find(([k]) => k === "sid")?.slice(1).join("=");
  if (!sid) return null;
  const s = await env.DB.prepare("SELECT user_id, expires_at, active_workspace_id FROM sessions WHERE token = ?")
    .bind(decodeURIComponent(sid))
    .first<{ user_id: string; expires_at: string; active_workspace_id: string | null }>();
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
  // 開いているワークスペースの所属。外れていたら一番古い所属 (本体の requireWorkspace と同じ扱い)
  const m =
    (s.active_workspace_id
      ? await env.DB.prepare("SELECT workspace_id, mcp_token FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
          .bind(s.active_workspace_id, s.user_id)
          .first<{ workspace_id: string; mcp_token: string | null }>()
      : null) ??
    (await env.DB.prepare("SELECT workspace_id, mcp_token FROM workspace_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1")
      .bind(s.user_id)
      .first<{ workspace_id: string; mcp_token: string | null }>());
  if (!m) return null;
  if (m.mcp_token) return m.mcp_token;
  const key = "addn_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("UPDATE workspace_members SET mcp_token = ? WHERE workspace_id = ? AND user_id = ? AND mcp_token IS NULL")
    .bind(key, m.workspace_id, s.user_id)
    .run();
  // 同時に別の承認が走っていたらそちらのキーを使う
  const r = await env.DB.prepare("SELECT mcp_token FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .bind(m.workspace_id, s.user_id)
    .first<{ mcp_token: string | null }>();
  return r?.mcp_token ?? null;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDueReminders(env));
    if (isDailySelfCheckTick(event)) ctx.waitUntil(runSelfCheck(env));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check — no auth.
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    // OAuth discovery / 動的クライアント登録 / 認可 / トークン (src/oauth.ts)
    if (isOAuthPath(url.pathname)) {
      return handleOAuth(
        request,
        env.OAUTH_SECRET,
        async (key) => {
          const probe = new Request(url.origin + "/mcp", { headers: { Authorization: `Bearer ${key}` } });
          return (await resolveAuth(probe, env)) !== null;
        },
        (req) => memberKeyFromSession(req, env),
        (jti) => claimOnce(env.DB, `oc:${jti}`)
      );
    }

    // /mcp (token via header/query) or /mcp/<token> (token embedded in the path)
    if (url.pathname !== "/mcp" && !/^\/mcp\/[^/]+\/?$/.test(url.pathname)) {
      // Humans (and misconfigured clients) land here when the path/token was
      // dropped from the connect URL — point them at the right shape.
      return jsonResponse({
        error: "not found",
        hint: "MCP endpoint は /mcp/<APIキー> です。こつこつアプリの 設定 > APIキー の「接続用URL」をそのまま使ってください (ドメインだけでは接続できません)。",
      }, 404);
    }

    // Auth gate for /mcp — resolves the workspace (and member scope) this token may act on.
    // 当てずっぽうのキーで叩き続けられないよう、接続元ごとに「失敗した認証」だけを数える。
    // 成功した要求は数えない (claude.ai など共有 IP からは多くの人が正しいキーで来るので、
    // 全要求を数えると正常利用まで止まる。2026-10-12 に本番でそれが起きた)。
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ipKey = `mcp:auth:${await shortHash(ip)}`;
    if (await rateLimitExceeded(env.DB, ipKey, 120, 10 * 60_000).catch(() => false)) {
      return jsonResponse(rpcError(null, RPC.INVALID_REQUEST, "too many requests"), 429);
    }
    const auth = await resolveAuth(request, env);
    if (!auth) {
      await rateLimited(env.DB, ipKey, 120, 10 * 60_000).catch(() => false);
      return jsonResponse(
        rpcError(null, RPC.INVALID_REQUEST, "unauthorized"),
        401,
        { "WWW-Authenticate": wwwAuthenticate(url.origin) }
      );
    }

    // The Streamable HTTP transport allows GET (for server-initiated SSE).
    // This server is stateless and never pushes, so refuse SSE cleanly — but a
    // plain browser GET (a human pasting the connect URL to self-diagnose) gets
    // a readable "who am I / what can I see" report instead of a bare 405.
    if (request.method === "GET") {
      const accept = request.headers.get("Accept") ?? "";
      if (!accept.includes("text/event-stream")) {
        const ws = await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?")
          .bind(auth.wsId).first<{ name: string }>();
        let goals: { name: string }[] = [];
        try {
          if (auth.scopeRoots) {
            const { results } = await env.DB.prepare(
              `${SUBTREE_CTE}
               SELECT name FROM projects WHERE id IN (SELECT id FROM sub) AND status != 'archived' AND workspace_id = ? ORDER BY order_idx`
            ).bind(auth.wsId, JSON.stringify(auth.scopeRoots), auth.wsId).all<{ name: string }>();
            goals = results ?? [];
          } else {
            const { results } = await env.DB.prepare(
              "SELECT name FROM projects WHERE status != 'archived' AND workspace_id = ? ORDER BY order_idx"
            ).bind(auth.wsId).all<{ name: string }>();
            goals = results ?? [];
          }
        } catch { /* diagnostics only — never fail the check */ }
        return jsonResponse({
          ok: true,
          message: "このAPIキーは有効です。このURLをそのまま claude.ai の 設定 > コネクタ > カスタムコネクタを追加 に貼ってください (コネクタ名は半角英数 kotsukotsu 推奨)。チャットで使う時は入力欄のツールメニューからこのコネクタを有効にしてください。",
          workspace: ws?.name ?? auth.wsId,
          workspaces: (await reachableWorkspaces(env, auth).catch(() => [])).map((w) => w.name),
          actor: auth.actor
            ? { name: auth.actor.name, role: auth.actor.role }
            : "ワークスペースキー (管理者として動作)",
          scope: auth.scopeRoots ? `アサイン範囲のみ (${auth.scopeRoots.length}ゴール起点)` : "ワークスペース全体",
          visible_goals: goals.map((g) => g.name),
        });
      }
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
    }

    // 1 本のキーあたりの回数制限 (600 回 / 10 分)。AI が暴走しても D1 を詰まらせない
    const keyTag = await shortHash(`${auth.wsId}:${auth.actor?.userId ?? "ws"}`);
    if (await rateLimited(env.DB, `mcp:calls:${keyTag}`, 3000, 10 * 60_000).catch(() => false)) {
      return jsonResponse(rpcError(null, RPC.INVALID_REQUEST, "too many requests (3000 / 10min)"), 429);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(rpcError(null, RPC.PARSE_ERROR, "invalid JSON"), 400);
    }

    // Batch support (array of requests). 上限 20 (無制限だと 1 要求で D1 を占有できる)
    if (Array.isArray(payload)) {
      if (payload.length > 20) return jsonResponse(rpcError(null, RPC.INVALID_REQUEST, "batch too large (max 20)"), 400);
      const responses = (
        await Promise.all(payload.map((m) => handleRpc(m, env, auth)))
      ).filter((r): r is object => r !== null);
      // If every entry was a notification, return 202 with no body.
      if (responses.length === 0) return new Response(null, { status: 202, headers: corsHeaders() });
      return jsonResponse(responses);
    }

    const response = await handleRpc(payload, env, auth);
    if (response === null) {
      // Notification -> 202 Accepted, no body (per Streamable HTTP spec).
      return new Response(null, { status: 202, headers: corsHeaders() });
    }
    return jsonResponse(response);
  },
};
