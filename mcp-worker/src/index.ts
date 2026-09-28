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

import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
// Same matcher the app uses for comment @mentions — one source of truth, so a
// name that notifies someone in the app notifies them through MCP too.
import { resolveMentionedMembers } from "../../app/lib/server/mentions";
import { workspaceToday } from "./today";
// claude.ai がキー無しURLで繋ぎに来た時の OAuth (動的クライアント登録) 経路。
import { handleOAuth, isOAuthPath, wwwAuthenticate } from "./oauth";

export interface Env {
  DB: D1Database;
  /** Same R2 bucket the main app uses for file resources (kotsukotsu-files). */
  /** R2 が無いアカウントでも動くように省略可。無ければファイル添付だけ使えない。 */
  FILES?: R2Bucket;
  /** Worker secret. Set via `wrangler secret put MCP_TOKEN`. */
  MCP_TOKEN: string;
  /** src/oauth.ts の認可コード暗号化鍵。`wrangler secret put OAUTH_SECRET` */
  OAUTH_SECRET?: string;
  /** Realtime worker (broadcasts "changed" so connected apps refetch). */
  RT_URL?: string;
  RT_SECRET?: string;
  /** Main app (holds the VAPID keys) — asked to push-notify phones. */
  PUSH_URL?: string;
  PUSH_SECRET?: string;
  /** Service bindings — workers.dev-to-workers.dev fetches 404, so the
   * callbacks above must go through these instead of the public URLs. */
  APP?: Fetcher;
  RT?: Fetcher;
}

// Tools that change data — after these run, nudge the realtime worker so every
// connected device refetches instantly.
const MUTATING_TOOLS = new Set([
  "create_goal", "update_goal", "move_goal", "add_subtask", "complete_subtask", "set_today",
  "send_chat", "edit_chat", "delete_chat", "create_notification", "assign_member_to_goal",
  "unassign_member_from_goal", "set_member_role", "create_invite", "upload_file",
]);
// Subset of MUTATING_TOOLS worth waking a phone for (mirrors the app's own
// push-eligible notification kinds: goal/streak/mention/info — see
// app/lib/server/queries.ts createNotification). Structural edits (move,
// rename, scheduling) stay realtime-only so AI bookkeeping doesn't spam phones.
// send_chat is absent on purpose: its handler decides the audience itself
// (@mentioned people + the task's/上位ゴールの担当者) and pushes to exactly
// those members instead of the generic goal-assignee push here.
const PUSH_TOOLS = new Set([
  "complete_subtask", "create_notification", "assign_member_to_goal", "upload_file",
]);
async function notifyRealtime(env: Env, wsId: string): Promise<void> {
  if (!env.RT_URL || !env.RT_SECRET) return;
  try {
    const doFetch = env.RT ? env.RT.fetch.bind(env.RT) : fetch;
    const r = await doFetch(`${env.RT_URL}/notify?ws=${encodeURIComponent(wsId)}`, {
      method: "POST",
      headers: { "x-rt-secret": env.RT_SECRET },
    });
    if (r.status >= 400) console.log(`[notifyRealtime] status=${r.status}`);
  } catch (e) {
    console.log(`[notifyRealtime] threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}
// This worker has no VAPID keys of its own (only the main app does), so a
// real phone push is a callback into the main app's internal endpoint rather
// than a duplicated push-signing implementation. When `emails` is given the
// push targets exactly those members (plus admins) instead of the goal's
// assignees — used by @mentions, which can point at anyone in the workspace.
type PushPayload = { title: string; body?: string | null; url?: string | null };
async function notifyPush(env: Env, wsId: string, goalId?: string | null, emails?: string[], payload?: PushPayload | null): Promise<void> {
  if (!env.PUSH_URL || !env.PUSH_SECRET) { console.log("[notifyPush] skipped: PUSH_URL/PUSH_SECRET unset"); return; }
  try {
    const doFetch = env.APP ? env.APP.fetch.bind(env.APP) : fetch;
    const r = await doFetch(`${env.PUSH_URL}/api/internal/push`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-push-secret": env.PUSH_SECRET },
      body: JSON.stringify({ workspaceId: wsId, goalId: goalId ?? null, emails: emails ?? null, payload: payload ?? null }),
    });
    console.log(`[notifyPush] status=${r.status}`);
  } catch (e) {
    console.log(`[notifyPush] threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Freeze a notification's audience at send time — same job as
// recordNotificationRecipients in app/lib/server/queries.ts. Without it the
// app recomputes visibility from the live assignment tree on every read, so
// unassigning someone (or moving a task) silently deleted notifications they
// had already received. Best effort: never fail the tool over bookkeeping.
// アサインで「この動きを知るべき人」を出す: そのゴールの担当者 + 親から根まで
// の担当者の全員 (app の goalNotificationRecipientEmails と同じ規則)。
async function goalWatcherEmails(env: Env, wsId: string, goalId: string): Promise<string[]> {
  const out = new Set<string>();
  let cur: string | null = goalId;
  for (let hop = 0; cur && hop < 30; hop++) {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT m.email AS email FROM goal_members gm
         JOIN members m ON m.id = gm.member_id
        WHERE gm.goal_id = ? AND m.workspace_id = ? AND m.email IS NOT NULL`
    ).bind(cur, wsId).all<{ email: string }>();
    for (const r of results ?? []) {
      const e = r.email.toLowerCase().trim();
      if (e) out.add(e);
    }
    const parent: { parent_goal_id: string | null } | null = await env.DB.prepare(
      "SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?"
    ).bind(cur, wsId).first<{ parent_goal_id: string | null }>();
    cur = parent?.parent_goal_id ?? null;
  }
  return [...out];
}

async function recordRecipients(env: Env, notificationId: string, wsId: string, goalId: string | null, targetEmail?: string | null): Promise<void> {
  try {
    let emails: string[];
    if (targetEmail) {
      emails = [targetEmail.toLowerCase().trim()];
    } else if (goalId) {
      // そのタスクの担当者 + 親から根までの担当者、全員。以前は最初にアサインが
      // 見つかった段で打ち切っていたが、それだと子タスクに担当が付いた瞬間から
      // 親の担当者(自分の顧客ゴールなど)に通知が飛ばなくなる (2026-09-09 黒崎指示:
      // アサインされている箇所の動きは必ず届かせる)。
      emails = await goalWatcherEmails(env, wsId, goalId);
    } else {
      return; // goal-less = workspace-wide, already visible to everyone
    }
    const uniq = [...new Set(emails.filter(Boolean))];
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO notification_recipients (notification_id, email) VALUES ${chunk.map(() => "(?,?)").join(",")}`
      ).bind(...chunk.flatMap((e) => [notificationId, e])).run();
    }
  } catch (e) {
    console.log(`[recordRecipients] threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-03-26";
// icons / websiteUrl は MCP 2025-11-25 の Implementation フィールド。コネクタ一覧の
// アイコンにアプリのファビコンを出してもらうため。
const SERVER_INFO = {
  name: "kotsukotsu-mcp",
  title: "こつこつ",
  version: "1.0.0",
  websiteUrl: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev",
  icons: [
    { src: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
    { src: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
    { src: "https://your-app-name.YOUR_SUBDOMAIN.workers.dev/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  ],
} as const;

// 完了の基準と現状は、人とAIが同じ文章を読んで動く唯一の場所。抽象的に書かれると
// 共有した意味が消えるので、書き方をツールの説明そのものに埋める (説明を読まずに
// 呼ぶことはできないため、instructions より取りこぼしが少ない)。
const COMPLETION_CRITERIA_DOC = [
  "完了の基準。「何が満たされたら完了か」だけを書く (やることは add_subtask へ)。",
  "必ず検証可能にする: 数値・期日・成果物名 (ファイル名/URL/画面名/テーブル名) のどれかを各行に入れる。",
  "禁止: 「検討する」「改善する」「整える」「いい感じにする」「運用が回っている」など、○×を付けられない表現。",
  "形式: リード文 → 空行 → 「□ 」で始まる項目を1行1個。",
  "例) この状態になったら完了。",
  "",
  "□ サービスLPを本番URLで公開し、スマホ実機でフォーム送信まで確認",
  "□ 2026-09-30 までに問い合わせ3件",
  "□ 成果物: lp/index.html と GA4 の cv イベント設定",
].join("\n");

const CURRENT_STATE_DOC = [
  "現状。読んだ人がその場で次の一手を選べる粒度で書く。",
  "必ず入れる3点: (1) 何日時点か (2) 済んだこと — 確認した事実・数字つき (3) 残り/詰まり — 何待ちかと、いつ誰に投げたか。",
  "禁止: 「進めている」「対応中」「順調」だけで終わる記述。タスクの羅列 (それは add_subtask へ)。",
  "1文=1行、話題の切れ目に空行。",
  "例)",
  "",
  "2026-09-12時点。ヒーローと料金表は実装しVercelにデプロイ済み、表示確認まで完了。",
  "",
  "残り: 画像3点の発注、フォームの送信先結線。",
  "詰まり: 先方のロゴデータ待ち (9/10にメール、返信なし)。",
].join("\n");

// Always-on system guidance handed to the connected AI on initialize. Tells it
// how to drive work through こつこつ: pull state → decompose → split AI/human →
// register → execute → human confirms.
const INSTRUCTIONS = `「こつこつ」はゴール起点のToDo・実行管理ツールです。ここが仕事の正のソースなので、状態の確認も、やったことの記録も、こつこつ上で完結させてください。誰がゴールを開いても「今どこまで進んでいて、次に何をするか」がタスクのチェック状態だけで分かる状態を保つのが目的です。

## 基本ループ

1. 把握
list_goals / get_goal / list_subtasks / list_today で現状を取得します。get_goal では完了基準(completion_criteria)と現状(current_state)を読み、何が満たされれば完了なのかを掴んでから動いてください。方針転換やフィードバックはコメント経由で来ることが多いので、そのゴールを触る前に list_comments も読みます。完了基準や現状が未記入なら、推測で進めず先に人へ確認するか記入を促してください。

読んだ完了基準・現状が下の「書き方」を満たしていない場合 (「検討する」「対応中」しか書いていない等) は、そのまま作業に入らず、分かっている事実で update_goal して具体化してから進みます。分からない部分は埋めずに、何が分からないかを send_chat で聞いてください。

2. 分解
完了基準から逆算して、実行可能な単位に砕きます。1タスク = 1アクション。「○○を検討する」ではなく「○○のドラフトを作成してチャットに投稿する」のように、終わったかどうかが判定できる形にします。

3. 完了基準と現状の書き方 (ここが甘いと共有した意味が消える)
この2つは、人とAIが同じ文章を読んで動く唯一の場所です。抽象的に書くと、読んだ側は結局本人に聞き直すことになります。

完了基準: 「何が満たされたら完了か」だけを、他人が○×を付けられる形で書く。各行に数値・期日・成果物名 (ファイル名/URL/画面名/テーブル名) のどれかを必ず入れる。「検討する」「改善する」「整える」「いい感じにする」は基準になりません。やることは書かず add_subtask へ。

現状: (1) 何日時点か (2) 済んだこと — 確認した事実と数字 (3) 残り・詰まり — 何待ちで、いつ誰に投げたか。この3点を必ず入れる。「進めている」「対応中」だけの現状は書かないでください。

create_goal は completion_criteria / current_state をその場で受け取れます。ゴールを作るときに一緒に書いてください。後から update_goal で足す前提にすると、その1回が飛んで基準の空いたゴールが溜まります。

4. 担当
タスク名に [AI] / [人+AI] / [人] のような担当区分は付けません。タスクはAIと人が一緒に進めるのが前提で、区分に情報がないためです。担当はアサインで表します。add_subtask / create_goal で作ったタスクは、作った本人に自動でアサインされます。別の人に持たせたいときだけ assign_member_to_goal で付け替えてください。
目標(ゴール)は顧客・事業・案件といった「タスクをぶら下げる箱」で、達成したい状態を名前にします(例:「自動車インフラ事業」「ロボケン」)。区分付きの名前を見つけたら update_goal で外してください。

5. 登録
砕いたタスクを add_subtask で1個ずつ該当ゴールの配下に登録します。複数アクションを1つに詰めないでください。やることを current_state や completion_criteria の文章として書くのも避けます。やることは必ずサブタスクとして持たせてください。

6. 実行
AIが進めるタスクも、着手前に作業ステップを2〜5個 add_subtask で登録してから始めます。1ステップ終わるごとに complete_subtask でチェックしてください。裏で全部進めて最後にまとめて報告する形だと、人からは途中経過が見えません。全ステップ終わったらタスク本体も complete_subtask でチェックし、create_notification で完了を知らせます(何を完了したか、次の一手を一言)。判断や成果は send_chat でそのゴールのスレッドに残します。コメントは接続している本人の名義で投稿されるので、本人が書いたとして自然な内容にしてください。

7. 確認
AIが進めたタスクの最終確認は人が行う前提です。完了基準に照らして満たせたかを判定し、結果を報告したうえで、人の承認が要る箇所を明示して止まります。重要判断・外向きの発信・金銭・契約は必ず人の承認を取ってください。

## 上位目標との整合を先に見る

着手前に、そのゴールの親チェーンを最上位まで辿ってください(get_goal の親情報 / list_goals のツリー)。次のどちらかに当てはまる場合は、分解も登録もせずいったん止めます。

- 最上位まで辿ってもチームの上位ゴールに属していない、孤立したゴール
- 親には繋がっているが、親ゴールの完了基準に寄与しない内容

止めたら、そのゴールの send_chat に「どの上位ゴールにも寄与していないこと」「なぜそう判断したか」「代わりに着手すべき上位ゴール直結のタスクを1つ」を書き、作成者を @メンションして create_notification でも知らせます。事実ベースで簡潔に書いてください。あわせて「確認: このゴールを上位ゴールに繋ぎ直すか破棄するか判断」をサブタスクとして登録し、人の判断が出るまでそのゴール配下は実行しません。move_goal での付け替え案を提示するのは構いませんが、実行は承認後です。

## メンバー・招待・アサイン

- list_members で現在のメンバーを確認します
- まだ居ない人は create_invite で招待リンクを発行し、本人に渡せる形で報告します
- 既にいるメンバーには assign_member_to_goal で担当を割り当てます(通知が飛びます)

誰がやるかまでこつこつ上で確定させます。人にしかできない作業(電話・対面・金銭判断・最終承認)は、タスク名にその内容が分かるように書き、その人にアサインしてください。

## 書式(現状・完了の基準)

- 現状と完了の基準は改行して書きます。1文=1行、話題の区切り(今どこ / ブロッカー / 次の一手 / 関連)は空行で分けます。改行のない長文の塊にしないでください
- 完了の基準は「リード文 → 空行 → □ チェック項目(1行に1個)」の形で、満たされた状態だけを書きます
- やることのリストを現状・完了の基準・コメントに書かないでください。add_subtask で1個ずつ登録します

## コメント・メンション

- send_chat の本文に「@表示名」(list_members の name 表記)を入れるとその人に通知が飛びます。名前内のスペースは省略可。「@全員」で全メンバーに通知
- 結果の notified で誰に通知されたか確認できます。空なら表示名が違うので list_members で確認して打ち直してください
- 投稿の修正は edit_chat、取り消しは delete_chat(自分名義の投稿のみ)

## リソース(共通ナレッジ)

- 成果物や参照すべきファイルは該当ゴールのリソースに入れて共有します。手元のファイルは upload_file で添付できます(base64、25MBまで、複数なら1ファイルずつ)
- 入れすぎないでください。増えるほど探しにくくなります。そのゴールを進めるのに効く最小限を保ち、古くなったものは整理します

## その他

- 階層を直したいときは move_goal で親の付け替えと並べ替えができます(parentId=null で最上位、beforeId で兄弟の並び順)。自分や子孫の配下への移動は自動で弾かれます
- AI単独で進められるところは止まらず進め、人が要る部分だけ明示して止まります
- 不明点は「確認: ...」のタスクとして登録し、人に質問を返してください

接続したら、まず現状を取得して、今日進めることを提案するところから始めてください。`;

/** initialize と指示再配信の両方で使う、権限付きの完全な指示文。 */
function buildInstructions(auth: McpAuth): string {
  let instructions = INSTRUCTIONS;
  if (auth.actor) {
    instructions += `\n\n## このセッションの権限\nあなたは「${auth.actor.name}」のAIとして接続しています (役割: ${auth.actor.role})。`;
    if (auth.scopeRoots) {
      instructions += `\nアクセスはアサインされたゴール (id: ${auth.scopeRoots.join(", ")}) とその配下の部分木に限定されています。範囲外のゴールは見えず、作成・移動も範囲内のみ可能です。メンバー管理・招待は使えません。この範囲の中で上記の基本ループを全力で回してください。`;
    }
  }
  return instructions;
}

// Instructions reach clients only at initialize, so a claude.ai conversation
// that outlives an edit to INSTRUCTIONS would keep running on stale rules until
// the user manually reconnects the connector. We edit these rules often, so
// re-delivery has to be automatic.
//
// It used to be keyed on an in-memory Set ("deliver once per worker isolate").
// That was wrong: isolates are recycled constantly, not only on deploy, so the
// Set reset all the time and the block ended up appended to nearly every tool
// result — pure noise in the caller's context.
//
// Now it is keyed on a content hash of the instructions, persisted in D1. Each
// (workspace, actor) gets the block exactly once per version of the text: edit
// the rules, and every live connection picks them up on its next tool call;
// leave them alone, and nothing is ever appended.
const instructionsVersion = (text: string): string => {
  // FNV-1a — we only need "did the text change", not cryptographic strength.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

const instructionsActorKey = (auth: McpAuth) => auth.actor?.userId ?? "ws-key";

/** Created lazily so a deploy needs no separate migration step. */
let deliveryTableReady = false;
async function ensureDeliveryTable(env: Env): Promise<void> {
  if (deliveryTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mcp_instruction_delivery (
       ws_id TEXT NOT NULL,
       actor_key TEXT NOT NULL,
       version TEXT NOT NULL,
       delivered_at TEXT NOT NULL,
       PRIMARY KEY (ws_id, actor_key)
     )`,
  ).run();
  deliveryTableReady = true;
}

async function markInstructionsDelivered(env: Env, auth: McpAuth, version: string): Promise<void> {
  await ensureDeliveryTable(env);
  await env.DB.prepare(
    `INSERT INTO mcp_instruction_delivery (ws_id, actor_key, version, delivered_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (ws_id, actor_key) DO UPDATE SET version = ?3, delivered_at = ?4`,
  ).bind(auth.wsId, instructionsActorKey(auth), version, new Date().toISOString()).run();
}

/** True when this caller has not yet seen the current text. */
async function instructionsAreStale(env: Env, auth: McpAuth, version: string): Promise<boolean> {
  await ensureDeliveryTable(env);
  const row = await env.DB.prepare(
    "SELECT version FROM mcp_instruction_delivery WHERE ws_id = ? AND actor_key = ?",
  ).bind(auth.wsId, instructionsActorKey(auth)).first<{ version: string }>();
  return row?.version !== version;
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// 「タスクを作った人がそのタスクの担当」— これが基本ルール (2026-09-08 黒崎指示)。
// 誰が作ったのかを user 単位で決める。
// - メンバーキー (auth.actor あり) → その本人
// - ワークスペースキー (auth.actor なし) → そのワークスペースの持ち主。
//   workspaces.created_by、無ければ workspace_members の admin のうち最古参。
//   ワークスペースキーは持ち主が自分の AI に持たせている鍵なので、そこから
//   作られたタスクの作成者は持ち主本人とみなすのが実態に合う。
type CreatorUser = { userId: string; name: string; email: string };

async function resolveCreator(env: Env, wsId: string, actor: McpAuth["actor"]): Promise<CreatorUser | null> {
  if (actor?.email) return { userId: actor.userId, name: actor.name, email: actor.email };
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.email
       FROM workspaces w JOIN users u ON u.id = w.created_by
      WHERE w.id = ? AND u.email IS NOT NULL`
  ).bind(wsId).first<{ user_id: string; name: string | null; email: string }>();
  if (row) return { userId: row.user_id, name: row.name || row.email, email: row.email };
  const adm = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.email
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? AND wm.role = 'admin' AND u.email IS NOT NULL
      ORDER BY wm.joined_at ASC LIMIT 1`
  ).bind(wsId).first<{ user_id: string; name: string | null; email: string }>();
  if (adm) return { userId: adm.user_id, name: adm.name || adm.email, email: adm.email };
  return null;
}

/** users 行に対応する members 行 (名簿) を返す。無ければ作る。 */
async function memberIdForUser(env: Env, wsId: string, user: CreatorUser, isAdmin: boolean): Promise<string> {
  const email = user.email.toLowerCase().trim();
  const found = await env.DB.prepare("SELECT id FROM members WHERE email = ? AND workspace_id = ?")
    .bind(email, wsId).first<{ id: string }>();
  if (found) return found.id;
  const memberId = uid();
  await env.DB.prepare("INSERT INTO members (id, name, role, email, workspace_id) VALUES (?,?,?,?,?)")
    .bind(memberId, user.name || email, isAdmin ? "Admin" : "None", email, wsId)
    .run();
  return memberId;
}

// created_by を立てて、作成者をそのゴールの担当 (編集可) にする。
// 割り当てた member_id を返す (誰にも解決できなかったときだけ null)。
async function assignCreatorAsHolder(env: Env, wsId: string, goalId: string, actor: McpAuth["actor"]): Promise<string | null> {
  const creator = await resolveCreator(env, wsId, actor);
  if (!creator) return null;
  await env.DB.prepare("UPDATE projects SET created_by = ? WHERE id = ? AND created_by IS NULL")
    .bind(creator.userId, goalId).run();
  const memberId = await memberIdForUser(env, wsId, creator, actor ? actor.role === "admin" : true);
  await env.DB.prepare("INSERT OR IGNORE INTO goal_members (goal_id, member_id, can_edit) VALUES (?, ?, 1)")
    .bind(goalId, memberId).run();
  return memberId;
}

// 作成者が誰なのか解決できなかったときだけの保険。親から根まで辿って最初に
// アサインのあるゴールを見つけ、その中で ワークスペース admin > members.role=Admin
// > 先にアサインされた順 で1人選ぶ。
// 以前はこれを作成者アサインと併用していたため、黒崎の AI が作ったタスクに
// 上位ゴールの担当者(田中など)が勝手に付いていた。今は assignCreatorAsHolder が
// 効いた時点でこの継承は呼ばない。通知は出さない — 自動付与で毎回鳴ると邪魔。
async function inheritAssigneeFromAncestors(env: Env, wsId: string, goalId: string, parentId: string | null): Promise<string | null> {
  let cur: string | null = parentId;
  let guard = 0;
  while (cur && guard++ < 50) {
    const pick = await env.DB.prepare(
      `SELECT gm.member_id AS member_id
         FROM goal_members gm
         JOIN members m ON m.id = gm.member_id AND m.workspace_id = ?
         LEFT JOIN users u ON u.email = m.email
         LEFT JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
        WHERE gm.goal_id = ? AND m.is_ai = 0
        ORDER BY COALESCE(wm.role = 'admin', 0) DESC, (m.role = 'Admin') DESC, gm.assigned_at ASC
        LIMIT 1`
    ).bind(wsId, wsId, cur).first<{ member_id: string }>();
    if (pick?.member_id) {
      await env.DB.prepare("INSERT OR IGNORE INTO goal_members (goal_id, member_id, can_edit) VALUES (?, ?, 1)")
        .bind(goalId, pick.member_id).run();
      return pick.member_id;
    }
    const row = await env.DB.prepare("SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?")
      .bind(cur, wsId).first<{ parent_goal_id: string | null }>();
    if (!row) break;
    cur = row.parent_goal_id;
  }
  return null;
}

// ---- file uploads (mirrors app/lib/server/files.ts + app/api/files/route.ts) ----
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB, same cap as the app's /api/files
function safeFileName(name: string): string {
  return (name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 80);
}
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Keep AI-written long-form fields (現状 / 完了の基準) readable even when the
 * caller sends a wall of text: every □ checklist item gets its own line, and a
 * text with no line breaks at all is split one-sentence-per-line.
 */
function formatFieldText(text: string): string {
  let t = text.replace(/\r\n/g, "\n");
  const hadBreaks = t.includes("\n");
  t = t.replace(/(?<!\n)[ \t]*□/g, "\n□");
  if (!hadBreaks) t = t.replace(/。(?![\n)）」』])/g, "。\n");
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
// 「今日」は UTC で出してはいけない。JST の朝9時より前は前日になり、「今日やる
// こと」が1日ずれる。ワークスペースのタイムゾーンで解釈する workspaceToday()
// (src/today.ts) を使う。以前あった todayIso() は UTC 固定だったので消した。

/** Constant-time-ish string compare to avoid trivial timing leaks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * What a presented token authorizes.
 * - Workspace tokens (workspaces.mcp_token / worker secret / legacy) act with
 *   full admin rights on ONE workspace: actor = null, scopeRoots = null.
 * - Member tokens (workspace_members.mcp_token) act AS that member: same
 *   workspace isolation, plus workspace role (admin/member) and confinement to
 *   the subtrees the member may work in. scopeRoots comes from the membership's
 *   scope_goal_id (goal-scoped invite) or, failing that, the member's actual
 *   goal assignments (goal_members) — "アサインされている範囲". A non-admin
 *   member with neither gets full workspace access (mirrors the app UI).
 */
type McpAuth = {
  wsId: string;
  scopeRoots: string[] | null;
  actor: { userId: string; name: string; email: string | null; role: string } | null;
};

async function resolveAuth(req: Request, env: Env): Promise<McpAuth | null> {
  // Token may come from the Authorization header (Bearer), the URL path
  // (/mcp/<token> — most reliable for claude.ai custom connectors, which can
  // drop query strings), OR a ?key= / ?token= query param (kept for existing
  // connections and CLI clients).
  let presented: string | null = null;
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) presented = m[1].trim();
  const url = new URL(req.url);
  if (!presented) {
    const pm = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (pm) presented = decodeURIComponent(pm[1]).trim() || null;
  }
  if (!presented) {
    presented = (url.searchParams.get("key") || url.searchParams.get("token") || "").trim() || null;
  }
  if (!presented) return null;
  // 1) Worker secret (wrangler secret put MCP_TOKEN) → scoped to the default workspace.
  if (env.MCP_TOKEN && safeEqual(presented, env.MCP_TOKEN)) return { wsId: "default", scopeRoots: null, actor: null };
  // 2) Per-workspace D1 key (managed from the app's 設定 > APIキー). Returns the
  //    owning workspace id, which scopes every subsequent query.
  try {
    const w = await env.DB.prepare("SELECT id FROM workspaces WHERE mcp_token = ? LIMIT 1").bind(presented).first<{ id: string }>();
    if (w?.id) return { wsId: w.id, scopeRoots: null, actor: null };
  } catch { /* table may not exist yet */ }
  // 3) Per-member key (app 設定 > APIキー). Acts as that member. Scope priority:
  //    scope_goal_id (goal-scoped invite) > goal_members assignments > full WS.
  try {
    const mem = await env.DB.prepare(
      `SELECT wm.workspace_id, wm.user_id, wm.role, wm.scope_goal_id, u.name, u.email
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
        WHERE wm.mcp_token = ? LIMIT 1`
    ).bind(presented).first<{ workspace_id: string; user_id: string; role: string; scope_goal_id: string | null; name: string | null; email: string | null }>();
    if (mem) {
      let scopeRoots: string[] | null = null;
      if (mem.scope_goal_id) {
        scopeRoots = [mem.scope_goal_id];
      } else if (mem.role !== "admin" && mem.email) {
        // the member's actual assignments (roster row matched by email)
        const { results } = await env.DB.prepare(
          `SELECT gm.goal_id FROM goal_members gm
             JOIN members m ON m.id = gm.member_id
            WHERE m.workspace_id = ? AND lower(m.email) = lower(?)`
        ).bind(mem.workspace_id, mem.email).all<{ goal_id: string }>();
        const ids = (results ?? []).map((r) => r.goal_id);
        if (ids.length) scopeRoots = ids;
      }
      return {
        wsId: mem.workspace_id,
        scopeRoots,
        actor: { userId: mem.user_id, name: mem.name || mem.email || "メンバー", email: mem.email, role: mem.role },
      };
    }
  } catch { /* column may not exist yet */ }
  // 4) Legacy fallback: org_settings singleton key → default workspace.
  try {
    const row = await env.DB.prepare("SELECT mcp_token FROM org_settings WHERE id = 1").first<{ mcp_token: string | null }>();
    if (row?.mcp_token && safeEqual(presented, row.mcp_token)) return { wsId: "default", scopeRoots: null, actor: null };
  } catch { /* column may not exist yet */ }
  return null;
}

// ---- scope enforcement helpers -------------------------------------------

/** Is goalId inside the auth's scope? A null scope = the whole workspace.
 * In scope = the goal is one of the scope roots or a descendant of one. */
async function goalInScope(env: Env, auth: McpAuth, goalId: string): Promise<boolean> {
  if (!auth.scopeRoots) return true;
  let cur: string | null = goalId;
  let guard = 0;
  while (cur && guard++ < 100) {
    if (auth.scopeRoots.includes(cur)) return true;
    const r: { parent_goal_id: string | null } | null = await env.DB
      .prepare("SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?")
      .bind(cur, auth.wsId).first();
    if (!r) return false;
    cur = r.parent_goal_id;
  }
  return false;
}

/** Throw a not-found (never "forbidden" — don't reveal out-of-scope existence). */
async function assertGoalInScope(env: Env, auth: McpAuth, goalId: string): Promise<void> {
  if (!(await goalInScope(env, auth, goalId))) throw new Error(`goal not found: ${goalId}`);
}

/** Look up a node's goal and assert it is inside the scope. */
async function assertNodeInScope(env: Env, auth: McpAuth, nodeId: string): Promise<void> {
  if (!auth.scopeRoots) return;
  const n = await env.DB.prepare("SELECT project_id FROM nodes WHERE id = ? AND workspace_id = ?")
    .bind(nodeId, auth.wsId).first<{ project_id: string }>();
  if (!n) throw new Error(`node not found: ${nodeId}`);
  await assertGoalInScope(env, auth, n.project_id);
}

/** Workspace-token sessions (actor null) have admin rights; member tokens need role=admin. */
function assertAdmin(auth: McpAuth): void {
  if (auth.actor && auth.actor.role !== "admin") throw new Error("管理者権限が必要です (このAPIキーはメンバー権限です)");
}

// A comment may only be edited/deleted by whoever posted it: member tokens
// match on author_email (fallback: display name for pre-author_email rows),
// the workspace key matches its own shared-key persona posts. Editing someone
// else's words through MCP is never allowed — that's speech in their name.
function assertOwnMessage(auth: McpAuth, msg: { author: string | null; author_email: string | null }): void {
  if (auth.actor) {
    const email = auth.actor.email?.toLowerCase().trim();
    const ok = (msg.author_email && email && msg.author_email === email) || (!msg.author_email && msg.author === auth.actor.name);
    if (!ok) throw new Error("自分が投稿したコメントのみ編集・取り消しできます");
    return;
  }
  if (msg.author !== "AI(共有ワークスペーストークン経由)") {
    throw new Error("ワークスペースキーは自分(共有キー)名義の投稿のみ編集・取り消しできます");
  }
}

/** SQL fragment: recursive subtrees of ALL scope roots. Bind wsId + JSON array of root ids. */
const SUBTREE_CTE = `WITH RECURSIVE sub(id) AS (
  SELECT id FROM projects WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))
  UNION ALL
  SELECT p.id FROM projects p JOIN sub s ON p.parent_goal_id = s.id
)`;

function jsonResponse(body: unknown, status = 200, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(), ...(extra ?? {}) },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  };
}

// JSON-RPC error codes
const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type ToolHandler = (args: any, env: Env, wsId: string, auth: McpAuth) => Promise<unknown>;
interface ToolDef {
  description: string;
  schema: ZodType<any>;
  handler: ToolHandler;
}

/** Wrap a value as MCP tool result content (JSON text). */
function toolText(value: unknown) {
  // Compact JSON — clients parse this, they don't read it raw, and pretty-printing
  // roughly triples payload size on large list_* results for no benefit.
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// list_goals/list_subtasks are browse views — leave out current_state/completion_criteria
// (long free text, fetched individually via get_goal) so bulk listing doesn't blow the payload.
const GOAL_LIST_COLUMNS =
  "id, name, order_idx, created_at, emoji, deadline, owner, status, parent_goal_id";

const tools: Record<string, ToolDef> = {
  // ---- goals (projects) ----
  list_goals: {
    description:
      "List non-archived goals (projects), ordered by order_idx. Paginated — default 100, max 500 rows; pass offset to page further.",
    schema: z.object({
      limit: z.number().int().min(1).max(500).optional().describe("Max rows, default 100"),
      offset: z.number().int().min(0).optional().describe("Rows to skip, default 0"),
    }),
    handler: async (args, env, wsId, auth) => {
      const limit = args.limit ?? 100;
      const offset = args.offset ?? 0;
      if (auth.scopeRoots) {
        const { results } = await env.DB.prepare(
          `${SUBTREE_CTE}
           SELECT ${GOAL_LIST_COLUMNS} FROM projects WHERE id IN (SELECT id FROM sub) AND status != 'archived' AND workspace_id = ? ORDER BY order_idx LIMIT ? OFFSET ?`
        ).bind(wsId, JSON.stringify(auth.scopeRoots), wsId, limit, offset).all();
        return results;
      }
      const { results } = await env.DB.prepare(
        `SELECT ${GOAL_LIST_COLUMNS} FROM projects WHERE status != 'archived' AND workspace_id = ? ORDER BY order_idx LIMIT ? OFFSET ?`
      ).bind(wsId, limit, offset).all();
      return results;
    },
  },

  get_goal: {
    description: "Get a single goal (project) by id, including its subtask count.",
    schema: z.object({ id: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first();
      if (!row) throw new Error(`goal not found: ${args.id}`);
      return row;
    },
  },

  create_goal: {
    description:
      "Create a new goal (project). Appended to the end among its siblings. " +
      "Optionally nest under parentId (a scoped session creates under its scope goal by default).",
    schema: z.object({
      name: z.string().min(1).describe(
        "Goal name。達成したい状態や対象を名前にする。[AI] / [人] などの担当プレフィックスは付けない (担当はアサインで表す)"
      ),
      parentId: z.string().optional().describe("Parent goal id; omitted = top level (or the scope goal for scoped sessions)"),
      completion_criteria: z.string().optional().describe(COMPLETION_CRITERIA_DOC),
      current_state: z.string().optional().describe(CURRENT_STATE_DOC),
    }),
    handler: async (args, env, wsId, auth) => {
      // a scoped session may only create inside its subtrees — default to the
      // scope root when there is exactly one, otherwise the caller must pick
      const parentId: string | null =
        args.parentId ?? (auth.scopeRoots && auth.scopeRoots.length === 1 ? auth.scopeRoots[0] : null);
      if (auth.scopeRoots && !parentId) {
        throw new Error("parentId is required: 複数のゴールにアサインされているため、どのゴール配下に作成するか parentId で指定してください");
      }
      if (parentId) {
        await assertGoalInScope(env, auth, parentId);
        const parent = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(parentId, wsId).first();
        if (!parent) throw new Error(`parent goal not found: ${parentId}`);
      }
      const id = uid();
      const created = nowIso();
      const max = await env.DB.prepare(
        "SELECT COALESCE(MAX(order_idx), -1) AS m FROM projects WHERE workspace_id = ? AND parent_goal_id IS ?"
      ).bind(wsId, parentId).first<{ m: number }>();
      const orderIdx = (max?.m ?? -1) + 1;
      // 完了の基準と現状は作成時に一緒に書けるようにしてある。後から update_goal で
      // 足す作りだと、その1回が飛ばされて基準が空のままのゴールが積み上がる。
      await env.DB.prepare(
        "INSERT INTO projects (id, name, parent_goal_id, order_idx, created_at, status, workspace_id, completion_criteria, current_state) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
      )
        .bind(
          id,
          args.name.trim(),
          parentId,
          orderIdx,
          created,
          wsId,
          args.completion_criteria === undefined ? null : formatFieldText(args.completion_criteria),
          args.current_state === undefined ? null : formatFieldText(args.current_state)
        )
        .run();
      const assignee =
        (await assignCreatorAsHolder(env, wsId, id, auth.actor)) ??
        (await inheritAssigneeFromAncestors(env, wsId, id, parentId));
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
      return { ...(row as object), assigned_member_id: assignee };
    },
  },

  update_goal: {
    description:
      "Update fields on a goal (project). Only the provided fields are changed. " +
      "Supports name, current_state, completion_criteria, deadline, status.",
    schema: z.object({
      id: z.string().min(1),
      name: z.string().optional().describe(
        "目標名。[AI] / [人+AI] / [人] のプレフィックスは付けない (担当はアサインで表す)。既に付いているものを見つけたらここで外す"
      ),
      current_state: z.string().optional().describe(
        CURRENT_STATE_DOC
      ),
      completion_criteria: z.string().optional().describe(
        COMPLETION_CRITERIA_DOC
      ),
      deadline: z.string().optional().describe("ISO date/datetime string"),
      status: z.string().optional().describe("e.g. active / archived"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      if (args.current_state !== undefined) args.current_state = formatFieldText(args.current_state);
      if (args.completion_criteria !== undefined) args.completion_criteria = formatFieldText(args.completion_criteria);
      const fields: string[] = [];
      const binds: unknown[] = [];
      for (const key of ["name", "current_state", "completion_criteria", "deadline", "status"] as const) {
        if (args[key] !== undefined) {
          fields.push(`${key} = ?`);
          binds.push(args[key]);
        }
      }
      // archiving convenience: stamp archived_at when status flips to archived
      if (args.status === "archived") {
        fields.push("archived_at = ?");
        binds.push(nowIso());
      }
      if (fields.length === 0) throw new Error("no fields to update");
      binds.push(args.id, wsId);
      const res = await env.DB.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ? AND workspace_id = ?`)
        .bind(...binds)
        .run();
      if (!res.meta.changes) throw new Error(`goal not found: ${args.id}`);
      // アーカイブは配下ごと落とす。自分だけ落とすと、残った子が親を失って
      // 最上位に浮き上がり、文脈のないタスクがトップに並ぶ。
      if (args.status === "archived") {
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM projects WHERE parent_goal_id = ? AND workspace_id = ?
             UNION
             SELECT c.id FROM projects c JOIN sub ON c.parent_goal_id = sub.id WHERE c.workspace_id = ?
           )
           UPDATE projects SET status='archived', archived_at=?
            WHERE workspace_id = ? AND status != 'archived' AND id IN (SELECT id FROM sub)`
        ).bind(args.id, wsId, wsId, nowIso(), wsId).run();
      }
      return env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first();
    },
  },

  move_goal: {
    description:
      "Re-parent and/or reorder a goal in the tree. parentId = new parent goal " +
      "(null/omitted = move to the top level). beforeId = insert immediately " +
      "before that sibling (omitted/null = append to the end). Cannot move a goal " +
      "under itself or one of its own descendants (rejected). Siblings under the " +
      "destination are reindexed to a contiguous 0..n.",
    schema: z.object({
      id: z.string().min(1).describe("Goal (project) id to move"),
      parentId: z.string().nullable().optional().describe("New parent goal id; null or omitted = top level (root)"),
      beforeId: z.string().nullable().optional().describe("Sibling id to insert before; omitted/null = append to the end"),
    }),
    handler: async (args, env, wsId, auth) => {
      const id: string = args.id;
      const newParentId: string | null = args.parentId ?? null;
      const beforeId: string | null = args.beforeId ?? null;
      if (newParentId === id) throw new Error("cannot move a goal under itself");
      await assertGoalInScope(env, auth, id);
      // a scoped session can never move a goal to the top level (that would
      // lift it out of the subtree); the destination must be in scope too
      if (auth.scopeRoots && !newParentId) throw new Error("scoped session: parentId is required (must stay inside your assigned goals)");
      if (newParentId) await assertGoalInScope(env, auth, newParentId);
      const self = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
      if (!self) throw new Error(`goal not found: ${id}`);
      if (newParentId) {
        const dest = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(newParentId, wsId).first();
        if (!dest) throw new Error(`parent goal not found: ${newParentId}`);
        // cycle guard: walk up from the destination; hitting `id` means the
        // destination is a descendant of the moved node -> reject.
        let cur: string | null = newParentId;
        let guard = 0;
        while (cur && guard++ < 1000) {
          if (cur === id) throw new Error("cannot move a goal under its own descendant");
          const r: { parent_goal_id: string | null } | null = await env.DB
            .prepare("SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?")
            .bind(cur, wsId).first();
          cur = r?.parent_goal_id ?? null;
        }
      }
      // existing siblings under the destination (excluding the moved node), in order
      const sibsRes = newParentId
        ? await env.DB.prepare("SELECT id FROM projects WHERE parent_goal_id = ? AND status != 'archived' AND workspace_id = ? AND id <> ? ORDER BY order_idx ASC, created_at ASC").bind(newParentId, wsId, id).all()
        : await env.DB.prepare("SELECT id FROM projects WHERE parent_goal_id IS NULL AND status != 'archived' AND workspace_id = ? AND id <> ? ORDER BY order_idx ASC, created_at ASC").bind(wsId, id).all();
      const order = (sibsRes.results as { id: string }[]).map((s) => s.id);
      let insertAt = order.length;
      if (beforeId) {
        const idx = order.indexOf(beforeId);
        if (idx >= 0) insertAt = idx;
      }
      order.splice(insertAt, 0, id);
      await env.DB.prepare("UPDATE projects SET parent_goal_id = ? WHERE id = ? AND workspace_id = ?").bind(newParentId, id, wsId).run();
      if (order.length) {
        await env.DB.batch(order.map((sid, i) =>
          env.DB.prepare("UPDATE projects SET order_idx = ? WHERE id = ? AND workspace_id = ?").bind(i, sid, wsId)
        ));
      }
      return env.DB.prepare("SELECT id, name, parent_goal_id, order_idx FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
    },
  },

  // ---- subtasks (nodes) ----
  // NOTE: subtasks are child goals (the same `projects` rows the app's own
  // "タスク" list under a goal renders), NOT the separate `nodes` table. These
  // tools used to write to `nodes`, which nothing in the current app UI reads
  // (only an unused, unmounted Outliner component does) — every subtask
  // created that way was invisible in the app. Fixed to match what the UI
  // actually shows.
  list_subtasks: {
    description: "List subtasks (child goals) under a goal, ordered by order_idx.",
    schema: z.object({ goalId: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const { results } = await env.DB.prepare(
        `SELECT ${GOAL_LIST_COLUMNS} FROM projects WHERE parent_goal_id = ? AND status != 'archived' AND workspace_id = ? ORDER BY order_idx`
      )
        .bind(args.goalId, wsId)
        .all();
      return results;
    },
  },

  add_subtask: {
    description:
      "Add a subtask to a goal — creates it as a child goal, exactly like the app's " +
      "own 'タスク' list under this goal (and create_goal with parentId). order_idx " +
      "becomes max+1 among siblings. Call again with the new subtask's id as goalId " +
      "to nest another level. 担当者は自動で決まる: 作ったあなた本人 (返り値 assigned_member_id)。" +
      "別の人に持たせたいときだけ assign_member_to_goal。",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id to add the subtask under"),
      text: z.string().min(1).describe(
        "Subtask text。1タスク=1アクションで登録する (複数アクションを1個に詰めない)。[AI] / [人+AI] / [人] のプレフィックスは付けない (担当はアサインで表す)"
      ),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      const id = uid();
      const created = nowIso();
      const max = await env.DB.prepare(
        "SELECT COALESCE(MAX(order_idx), -1) AS m FROM projects WHERE workspace_id = ? AND parent_goal_id = ?"
      ).bind(wsId, args.goalId).first<{ m: number }>();
      const orderIdx = (max?.m ?? -1) + 1;
      await env.DB.prepare(
        "INSERT INTO projects (id, name, parent_goal_id, order_idx, created_at, status, workspace_id) VALUES (?, ?, ?, ?, ?, 'active', ?)"
      )
        .bind(id, args.text.trim(), args.goalId, orderIdx, created, wsId)
        .run();
      const assignee =
        (await assignCreatorAsHolder(env, wsId, id, auth.actor)) ??
        (await inheritAssigneeFromAncestors(env, wsId, id, args.goalId));
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
      return { ...(row as object), assigned_member_id: assignee };
    },
  },

  complete_subtask: {
    description: "Mark a subtask (child goal) complete or incomplete. Sets status to 'done' or 'active'.",
    schema: z.object({
      id: z.string().min(1).describe("Subtask (goal) id"),
      completed: z.boolean().describe("true = complete, false = reopen"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      const status = args.completed ? "done" : "active";
      // completed_at を残す。projects には status='done' しか無かったため
      // 「いつ終わったか」が一切残らず、速度も「提案は実行されたか」も測れなかった
      // (done_log は nodes 側の完了しか書かない)。
      const res = await env.DB.prepare(
        "UPDATE projects SET status = ?, completed_at = ? WHERE id = ? AND workspace_id = ?"
      )
        .bind(status, args.completed ? nowIso() : null, args.id, wsId)
        .run();
      if (!res.meta.changes) throw new Error(`subtask not found: ${args.id}`);
      if (args.completed) {
        // 親を完了したら配下も完了にする (queries.ts の cascadeGoalDone と同じ挙動)。
        // 伝播させないと閉じた親の下に未完のものが残り、一覧・検索・「今日」に出続ける。
        // ゴールだけでなく、ゴールがぶら下げている小タスク (nodes) も閉じること。
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM projects WHERE id = ?1 AND workspace_id = ?2
             UNION ALL
             SELECT p.id FROM projects p JOIN sub ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?2
           )
           UPDATE projects SET status = 'done', completed_at = ?3
            WHERE workspace_id = ?2 AND status = 'active' AND id IN (SELECT id FROM sub)`
        )
          .bind(args.id, wsId, nowIso())
          .run();
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM projects WHERE id = ?1 AND workspace_id = ?2
             UNION ALL
             SELECT p.id FROM projects p JOIN sub ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?2
           )
           UPDATE nodes SET completed_at = ?3, updated_at = ?3
            WHERE workspace_id = ?2 AND completed_at IS NULL AND project_id IN (SELECT id FROM sub)`
        )
          .bind(args.id, wsId, nowIso())
          .run();
        // mirrors the app's own toggleProjectDone (queries.ts) — without this
        // the phone push callback fires with nothing new to show.
        const goal = await env.DB.prepare("SELECT name FROM projects WHERE id = ?").bind(args.id).first<{ name: string | null }>();
        if (goal?.name?.trim()) {
          const notifId = uid();
          await env.DB.prepare(
            "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, 'goal', ?, ?, ?, ?, ?)"
          )
            .bind(notifId, "完了", `「${goal.name.trim()}」を完了しました`, args.id, nowIso(), wsId)
            .run();
          await recordRecipients(env, notifId, wsId, args.id);
        }
      }
      return env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first();
    },
  },

  // ---- today ----
  // 「今日やる」は2つのテーブルに載っている。type: "goal" が生きているモデル
  // (projects — アプリが描画しているもの。set_today が書く)、
  // type: "node" が旧アウトライナー (nodes — UI からは切れているが、過去に
  // set_today で入れたものと due リマインダーがまだ参照している)。両方返す。
  // 以前は nodes だけを見ていたため、list_today が常に
  // 空を返していた (データが無いのではなく線が繋がっていなかった)。
  list_today: {
    description:
      "List everything scheduled for a given day (today_date). Defaults to today " +
      "in the workspace timezone (workspaces.timezone, default Asia/Tokyo). " +
      "Each row carries type: \"goal\" (the live model — what set_today and the app write) " +
      "or type: \"node\" (legacy outliner rows). done は status='done' / completed_at で判定できる。",
    schema: z.object({
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today in the workspace timezone"),
    }),
    handler: async (args, env, wsId, auth) => {
      const date = args.date ?? (await workspaceToday(env.DB, wsId)).date;
      const scoped = !!auth.scopeRoots;
      const rootsJson = scoped ? JSON.stringify(auth.scopeRoots) : null;

      // 生きているモデル: projects.today_date
      const goalSql = scoped
        ? `${SUBTREE_CTE}
           SELECT 'goal' AS type, p.id, p.name AS text, p.status, p.completed_at, p.deadline,
                  p.parent_goal_id AS project_id, par.name AS project_name, p.order_idx
             FROM projects p LEFT JOIN projects par ON par.id = p.parent_goal_id
            WHERE p.today_date = ? AND p.workspace_id = ? AND p.id IN (SELECT id FROM sub)
            ORDER BY p.order_idx`
        : `SELECT 'goal' AS type, p.id, p.name AS text, p.status, p.completed_at, p.deadline,
                  p.parent_goal_id AS project_id, par.name AS project_name, p.order_idx
             FROM projects p LEFT JOIN projects par ON par.id = p.parent_goal_id
            WHERE p.today_date = ? AND p.workspace_id = ?
            ORDER BY p.order_idx`;
      const goalBinds = scoped ? [wsId, rootsJson, date, wsId] : [date, wsId];
      const goals = await env.DB.prepare(goalSql).bind(...goalBinds).all();

      // 旧アウトライナー: nodes.today_date
      const nodeSql = scoped
        ? `${SUBTREE_CTE}
           SELECT 'node' AS type, n.*, p.name AS project_name
             FROM nodes n JOIN projects p ON p.id = n.project_id
            WHERE n.today_date = ? AND n.workspace_id = ? AND n.project_id IN (SELECT id FROM sub)
            ORDER BY p.order_idx, n.order_idx`
        : `SELECT 'node' AS type, n.*, p.name AS project_name
             FROM nodes n JOIN projects p ON p.id = n.project_id
            WHERE n.today_date = ? AND n.workspace_id = ?
            ORDER BY p.order_idx, n.order_idx`;
      const nodeBinds = scoped ? [wsId, rootsJson, date, wsId] : [date, wsId];
      const nodes = await env.DB.prepare(nodeSql).bind(...nodeBinds).all();

      return { date, items: [...(goals.results ?? []), ...(nodes.results ?? [])] };
    },
  },

  set_today: {
    description:
      "Schedule one item for a day, or clear it. Pass date = null to remove it from any day. " +
      "id はゴール(タスク)の id でも、旧アウトライナーの node id でもよい — 先にゴールとして探し、無ければ node として扱う。",
    schema: z.object({
      id: z.string().min(1).optional().describe("Goal (task) id, or legacy node id"),
      nodeId: z.string().min(1).optional().describe("旧引数名。id と同じ扱い (既存の呼び出しのために残してある)"),
      date: z.string().nullable().describe("YYYY-MM-DD, or null to clear"),
    }),
    handler: async (args, env, wsId, auth) => {
      const id: string | undefined = args.id ?? args.nodeId;
      if (!id) throw new Error("id が必要です");

      // まずゴールとして扱う (生きているモデル)。
      const asGoal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?")
        .bind(id, wsId).first<{ id: string }>();
      if (asGoal) {
        await assertGoalInScope(env, auth, id);
        await env.DB.prepare("UPDATE projects SET today_date = ? WHERE id = ? AND workspace_id = ?")
          .bind(args.date, id, wsId).run();
        return { type: "goal", ...(await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first() as object) };
      }

      // 見つからなければ旧アウトライナーの node。
      await assertNodeInScope(env, auth, id);
      const res = await env.DB.prepare(
        "UPDATE nodes SET today_date = ?, updated_at = ? WHERE id = ? AND workspace_id = ?"
      )
        .bind(args.date, nowIso(), id, wsId)
        .run();
      if (!res.meta.changes) throw new Error(`not found: ${id}`);
      return { type: "node", ...(await env.DB.prepare("SELECT * FROM nodes WHERE id = ? AND workspace_id = ?").bind(id, wsId).first() as object) };
    },
  },

  // ---- chat (goal thread comments, attributed to the human behind the token) ----
  send_chat: {
    description:
      "Post a comment to a goal's thread. The comment is attributed to the human this " +
      "session's token belongs to (the member whose AI is acting) — never to an AI persona. " +
      "メンションの書き方: 本文に「@表示名」を含めるとその人に通知が飛ぶ (例: @山田太郎 確認お願いします)。" +
      "表示名は list_members の name をそのまま使う (名前内のスペースは省略してもよい)。「@全員」で全メンバーに通知。" +
      "結果の notified 配列で誰に通知が飛んだかを確認できる — メンションしたのに notified が空なら表示名が間違っている。",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id"),
      body: z.string().min(1).describe("Message body. Mention with @表示名 (from list_members) or @全員 to notify people."),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      // the goal must belong to this workspace before posting to its thread
      const goal = await env.DB.prepare("SELECT id, name FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first<{ id: string; name: string | null }>();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      // A workspace-wide key has no specific human behind it — attributing it
      // to "the workspace's first admin" silently mislabeled every shared-key
      // AI action as that admin personally. Be honest instead: whoever wants
      // their own name on their AI's posts needs their own per-member key
      // (設定 > APIキー).
      const author = auth.actor?.name ?? "AI(共有ワークスペーストークン経由)";
      const authorEmail = auth.actor?.email?.toLowerCase().trim() ?? null;
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO chat_messages (id, goal_id, scope, role, author, author_email, body, created_at, workspace_id) VALUES (?, ?, 'goal', 'user', ?, ?, ?, ?, ?)"
      )
        .bind(id, args.goalId, author, authorEmail, args.body, nowIso(), wsId)
        .run();
      // @name mentions -> notify only the mentioned person (mirrors the app's
      // queries.ts sendMessage — comments no longer broadcast to everyone with
      // goal access, longest name first so a shorter name can't shadow-match).
      // Resolves against every workspace member, not just the goal's assignees,
      // so mentioning someone who isn't assigned still notifies them. Names are
      // also matched with their spaces stripped ("山田　太郎" hits on @山田太郎).
      const { results: members } = await env.DB.prepare(
        `SELECT id, name, email FROM members WHERE workspace_id = ?`
      ).bind(wsId).all<{ id: string; name: string | null; email: string | null }>();
      const mentioned = resolveMentionedMembers(
        args.body,
        (members ?? []).map((m) => ({ id: m.id, name: m.name ?? "", email: m.email }))
      );
      const notifiedEmails = new Set<string>();
      const notifiedNames: string[] = [];
      for (const m of mentioned) {
        const email = m.email?.toLowerCase().trim();
        if (!email || notifiedEmails.has(email)) continue;
        notifiedEmails.add(email);
        notifiedNames.push(m.name);
        const notifId = uid();
        await env.DB.prepare(
          "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'mention', ?, ?, ?, ?, ?, ?)"
        )
          .bind(notifId, `${author}さんからメンション`, `「${goal.name ?? "タスク"}」: ${args.body}`, args.goalId, nowIso(), wsId, email)
          .run();
        await recordRecipients(env, notifId, wsId, args.goalId, email);
      }
      // Wake exactly the mentioned people's phones (the dispatcher's generic
      // goal-assignee push is skipped for send_chat — see PUSH_TOOLS).
      if (notifiedEmails.size) {
        await notifyPush(env, wsId, null, [...notifiedEmails], {
          title: `${author}さんからメンション`,
          body: `「${goal.name ?? "タスク"}」: ${args.body}`,
          url: `/goals/${args.goalId}`,
        });
      }
      // メンションが無いコメントも、担当している人 (そのタスク + 上位ゴール) には
      // 届かせる (2026-09-09 黒崎指示)。1人ずつ target_email 付きで出すので、
      // 関係ない人には出ない。投稿者自身は鳴らさない。
      const watcherEmails = (await goalWatcherEmails(env, wsId, args.goalId)).filter(
        (e) => !notifiedEmails.has(e) && e !== authorEmail
      );
      for (const email of watcherEmails) {
        const notifId = uid();
        await env.DB.prepare(
          "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'info', ?, ?, ?, ?, ?, ?)"
        )
          .bind(notifId, `${author}さんがコメント`, `「${goal.name ?? "タスク"}」: ${args.body}`, args.goalId, nowIso(), wsId, email)
          .run();
        await recordRecipients(env, notifId, wsId, args.goalId, email);
      }
      if (watcherEmails.length) {
        await notifyPush(env, wsId, null, watcherEmails, {
          title: `${author}さんがコメント`,
          body: `「${goal.name ?? "タスク"}」: ${args.body}`,
          url: `/goals/${args.goalId}`,
        });
      }
      const row = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?").bind(id).first();
      return { ...(row ?? { id }), notified: notifiedNames };
    },
  },

  edit_chat: {
    description:
      "Edit a comment you previously posted (by chat message id from list_comments). " +
      "Member tokens can only edit their own comments; the workspace key can edit " +
      "comments it posted (author 'AI(共有ワークスペーストークン経由)').",
    schema: z.object({
      messageId: z.string().min(1).describe("Chat message id"),
      body: z.string().min(1).describe("New message body"),
    }),
    handler: async (args, env, wsId, auth) => {
      const msg = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ? AND workspace_id = ?").bind(args.messageId, wsId).first<{ id: string; goal_id: string | null; author: string | null; author_email: string | null }>();
      if (!msg) throw new Error(`message not found: ${args.messageId}`);
      if (msg.goal_id) await assertGoalInScope(env, auth, msg.goal_id);
      assertOwnMessage(auth, msg);
      await env.DB.prepare("UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?").bind(args.body, nowIso(), args.messageId).run();
      return env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?").bind(args.messageId).first();
    },
  },

  delete_chat: {
    description:
      "Delete (取り消し) a comment you previously posted (by chat message id from " +
      "list_comments). Member tokens can only delete their own comments; the workspace " +
      "key can delete comments it posted.",
    schema: z.object({
      messageId: z.string().min(1).describe("Chat message id"),
    }),
    handler: async (args, env, wsId, auth) => {
      const msg = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ? AND workspace_id = ?").bind(args.messageId, wsId).first<{ id: string; goal_id: string | null; author: string | null; author_email: string | null }>();
      if (!msg) throw new Error(`message not found: ${args.messageId}`);
      if (msg.goal_id) await assertGoalInScope(env, auth, msg.goal_id);
      assertOwnMessage(auth, msg);
      await env.DB.prepare("DELETE FROM chat_messages WHERE id = ?").bind(args.messageId).run();
      return { ok: true, deleted: args.messageId };
    },
  },

  list_comments: {
    description:
      "List comments (chat messages) posted on a goal's thread, oldest first. " +
      "Team members leave feedback/instructions via comments — read this before " +
      "acting on a goal to see what they've actually asked for.",
    schema: z.object({ goalId: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const { results } = await env.DB.prepare(
        "SELECT id, goal_id, role, author, body, created_at FROM chat_messages WHERE goal_id = ? AND workspace_id = ? ORDER BY created_at ASC"
      ).bind(args.goalId, wsId).all();
      return results;
    },
  },

  // ---- resources ----
  list_resources: {
    description: "List resources attached to a goal, newest first.",
    schema: z.object({ goalId: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const { results } = await env.DB.prepare(
        "SELECT * FROM resources WHERE goal_id = ? AND workspace_id = ? ORDER BY updated_at DESC"
      )
        .bind(args.goalId, wsId)
        .all();
      return results;
    },
  },

  upload_file: {
    description:
      "Attach a file to a goal's resources (stored in R2, same as the app's file upload). " +
      "Also posts a chat message so it shows up in the goal's thread. One file per call — " +
      "call this once per file when sending multiple files. Max 25MB per file. Every file " +
      "must ship with a caption explaining what it is — a bare file with no explanation is " +
      "not useful to whoever opens the goal later.",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id to attach the file to"),
      filename: z.string().min(1).describe("Original file name, e.g. 見積書.pdf"),
      contentBase64: z.string().min(1).describe("Base64-encoded file bytes"),
      mimeType: z.string().optional().describe("MIME type, e.g. application/pdf"),
      caption: z.string().min(1).describe("Required: what this file is, shown next to it in the goal's resources (e.g. \"最新の見積書、税込\")"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const goal = await env.DB.prepare("SELECT id, name FROM projects WHERE id = ? AND workspace_id = ?")
        .bind(args.goalId, wsId).first<{ id: string; name: string | null }>();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);

      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(args.contentBase64);
      } catch {
        throw new Error("invalid contentBase64: not valid base64");
      }
      if (bytes.byteLength === 0) throw new Error("empty file");
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("ファイルが大きすぎます (25MBまで)");

      if (!env.FILES) throw new Error("ファイル置き場 (R2) が設定されていません");
      const key = `${wsId}/${args.goalId}/${uid()}-${safeFileName(args.filename)}`;
      await env.FILES.put(key, bytes, {
        httpMetadata: { contentType: args.mimeType || "application/octet-stream" },
      });

      const resourceId = uid();
      await env.DB.prepare(
        "INSERT INTO resources (id, goal_id, name, kind, content, url, workspace_id) VALUES (?,?,?,?,?,?,?)"
      )
        .bind(resourceId, args.goalId, args.filename.trim() || "無題", "file", args.caption?.trim() || null, `r2:${key}`, wsId)
        .run();

      // post to the goal's chat thread so it "pops in", same author-resolution as send_chat
      const author = auth.actor?.name ?? "AI(共有ワークスペーストークン経由)";
      const chatBody = `ファイルを追加しました: ${args.filename}`;
      await env.DB.prepare(
        "INSERT INTO chat_messages (id, goal_id, scope, role, author, body, created_at, workspace_id) VALUES (?, ?, 'goal', 'user', ?, ?, ?, ?)"
      )
        .bind(uid(), args.goalId, author, chatBody, nowIso(), wsId)
        .run();
      const fileNotifId = uid();
      await env.DB.prepare(
        "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, 'info', ?, ?, ?, ?, ?)"
      )
        .bind(fileNotifId, "ファイルが追加されました", `「${goal.name ?? "タスク"}」: ${args.filename}`, args.goalId, nowIso(), wsId)
        .run();
      await recordRecipients(env, fileNotifId, wsId, args.goalId);

      return env.DB.prepare("SELECT * FROM resources WHERE id = ?").bind(resourceId).first();
    },
  },

  // ---- notifications ----
  create_notification: {
    description:
      "Create a notification shown in the app. kind defaults to 'info'. " +
      "Optionally tie it to a goal via goalId.",
    schema: z.object({
      title: z.string().min(1).describe("Notification title"),
      body: z.string().optional().describe("Notification body"),
      kind: z.string().optional().describe("e.g. info / warning / success"),
      goalId: z.string().optional().describe("Related goal (project) id"),
    }),
    handler: async (args, env, wsId, auth) => {
      // scoped sessions pin their notifications to a scope subtree
      const goalId: string | null =
        args.goalId ?? (auth.scopeRoots && auth.scopeRoots.length === 1 ? auth.scopeRoots[0] : null);
      if (auth.scopeRoots && !goalId) {
        throw new Error("goalId is required: 複数のゴールにアサインされているため、どのゴール宛の通知か goalId で指定してください");
      }
      // if tied to a goal, that goal must be in this workspace (and in scope)
      if (goalId) {
        await assertGoalInScope(env, auth, goalId);
        const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(goalId, wsId).first();
        if (!goal) throw new Error(`goal not found: ${goalId}`);
      }
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, args.kind ?? "info", args.title, args.body ?? null, goalId, nowIso(), wsId)
        .run();
      await recordRecipients(env, id, wsId, goalId);
      return env.DB.prepare("SELECT * FROM notifications WHERE id = ?").bind(id).first();
    },
  },

  list_notifications: {
    description:
      "List notifications, most recent first (default 20, max 100). Filter by goalId and/or unreadOnly.",
    schema: z.object({
      goalId: z.string().optional().describe("Only notifications tied to this goal"),
      unreadOnly: z.boolean().optional().describe("true = only unread (read_at IS NULL)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max rows, default 20"),
    }),
    handler: async (args, env, wsId, auth) => {
      const limit = args.limit ?? 20;
      const unreadClause = args.unreadOnly ? " AND read_at IS NULL" : "";

      if (args.goalId) {
        await assertGoalInScope(env, auth, args.goalId);
        const { results } = await env.DB.prepare(
          `SELECT id, kind, title, body, goal_id, read_at, created_at FROM notifications
           WHERE workspace_id = ? AND goal_id = ?${unreadClause} ORDER BY created_at DESC LIMIT ?`
        ).bind(wsId, args.goalId, limit).all();
        return results;
      }

      if (auth.scopeRoots) {
        const { results } = await env.DB.prepare(
          `${SUBTREE_CTE}
           SELECT id, kind, title, body, goal_id, read_at, created_at FROM notifications
           WHERE workspace_id = ? AND goal_id IN (SELECT id FROM sub)${unreadClause} ORDER BY created_at DESC LIMIT ?`
        ).bind(wsId, JSON.stringify(auth.scopeRoots), wsId, limit).all();
        return results;
      }

      const { results } = await env.DB.prepare(
        `SELECT id, kind, title, body, goal_id, read_at, created_at FROM notifications
         WHERE workspace_id = ?${unreadClause} ORDER BY created_at DESC LIMIT ?`
      ).bind(wsId, limit).all();
      return results;
    },
  },

  // ---- members & access control (admin) ----
  list_members: {
    description: "List all members in the roster (id, name, email, role).",
    schema: z.object({}),
    handler: async (_args, env, wsId) => {
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, role FROM members WHERE workspace_id = ?"
      ).bind(wsId).all();
      return results;
    },
  },

  assign_member_to_goal: {
    description:
      "Assign a member to a goal (grants access). canEdit defaults to false " +
      "(view-only). No-op if the member is already assigned.",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id"),
      memberId: z.string().min(1).describe("Member id"),
      canEdit: z.boolean().optional().describe("true = can edit, defaults to false"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      // both the goal and the member must live in this workspace
      const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      const member = await env.DB.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ?").bind(args.memberId, wsId).first();
      if (!member) throw new Error(`member not found: ${args.memberId}`);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO goal_members (goal_id, member_id, can_edit) VALUES (?, ?, ?)"
      )
        .bind(args.goalId, args.memberId, args.canEdit ? 1 : 0)
        .run();
      return { ok: true };
    },
  },

  unassign_member_from_goal: {
    description: "Remove a member's assignment from a goal (revokes access).",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id"),
      memberId: z.string().min(1).describe("Member id"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      await env.DB.prepare(
        "DELETE FROM goal_members WHERE goal_id = ? AND member_id = ?"
      )
        .bind(args.goalId, args.memberId)
        .run();
      return { ok: true };
    },
  },

  set_member_role: {
    description:
      "Promote a member to admin or demote to member. Updates the roster row and, " +
      "if the member has a matching auth account (by email), the real auth permission " +
      "on users.role too.",
    schema: z.object({
      memberId: z.string().min(1).describe("Member id"),
      role: z.enum(["admin", "member"]).describe("admin = full access, member = none"),
    }),
    handler: async (args, env, wsId, auth) => {
      assertAdmin(auth);
      const member = await env.DB.prepare("SELECT email FROM members WHERE id = ? AND workspace_id = ?")
        .bind(args.memberId, wsId)
        .first<{ email: string | null }>();
      const memberRole = args.role === "admin" ? "Admin" : "None";
      const res = await env.DB.prepare("UPDATE members SET role = ? WHERE id = ? AND workspace_id = ?")
        .bind(memberRole, args.memberId, wsId)
        .run();
      if (!res.meta.changes) throw new Error(`member not found: ${args.memberId}`);
      // change the role only WITHIN this workspace (workspace_members), never the
      // user's global identity — so an AI on WS-B can't escalate someone in WS-A.
      if (member?.email) {
        const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(member.email).first<{ id: string }>();
        if (u?.id) {
          await env.DB.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?")
            .bind(args.role, wsId, u.id)
            .run();
        }
      }
      return { ok: true };
    },
  },

  create_invite: {
    description:
      "Create an invite link (token valid 7 days). Optionally pre-bind an email and " +
      "role (defaults to 'member'). Returns the token and a ready-to-share join URL.",
    schema: z.object({
      email: z.string().optional().describe("Pre-bind the invite to an email"),
      role: z.enum(["admin", "member"]).optional().describe("Role granted on accept, defaults to 'member'"),
    }),
    handler: async (args, env, wsId, auth) => {
      assertAdmin(auth);
      const token = uid();
      const role = args.role ?? "member";
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO invites (token, email, role, expires_at, workspace_id) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(token, args.email ?? null, role, expires, wsId)
        .run();
      return {
        token,
        url: (env.PUSH_URL ?? "https://your-app-name.YOUR_SUBDOMAIN.workers.dev") + "/login?invite=" + token,
      };
    },
  },
};

// Precompute the tools/list payload (JSON Schema per tool).
const TOOLS_LIST = Object.entries(tools).map(([name, def]) => {
  // Inline schema (no $ref wrapper) — MCP clients expect a self-contained object.
  const { $schema, ...inputSchema } = zodToJsonSchema(def.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return { name, description: def.description, inputSchema };
});

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

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
      // The client is receiving them right here, so this connection is current.
      await markInstructionsDelivered(env, auth, instructionsVersion(instructions)).catch((err) => {
        console.log(`instruction delivery bookkeeping failed: ${err?.message ?? err}`);
      });
      return rpcResult(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions,
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // ack-only

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS_LIST });

    case "tools/call": {
      const name = params?.name as string;
      const def = tools[name];
      if (!def) return rpcError(id, RPC.METHOD_NOT_FOUND, `unknown tool: ${name}`);

      const parsed = def.schema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return rpcError(id, RPC.INVALID_PARAMS, "invalid tool arguments", parsed.error.flatten());
      }
      try {
        const result = await def.handler(parsed.data, env, wsId, auth);
        if (MUTATING_TOOLS.has(name)) await notifyRealtime(env, wsId);
        if (PUSH_TOOLS.has(name)) {
          // most PUSH_TOOLS take goalId directly; complete_subtask's id IS the
          // goal (subtasks are child goals), so fall back to the result's own id.
          const goalId =
            (parsed.data as { goalId?: string })?.goalId ?? (name === "complete_subtask" ? (result as { id?: string } | null)?.id ?? null : null);
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
        } catch (err: any) {
          console.log(`instruction refresh skipped: ${err?.message ?? err}`);
        }
        return rpcResult(id, res);
      } catch (err: any) {
        // Tool execution error -> isError result (per MCP spec) so the model sees it.
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
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
// Cron: due-date reminders (wrangler.jsonc triggers.crons)
// ---------------------------------------------------------------------------
// Sweeps every node with a due_at that has arrived and hasn't reminded yet,
// fires one notification per task (targeted the same way any goal-linked
// event is — everyone assigned to that goal), marks it reminded_at so the
// next sweep skips it, and wakes phones for that goal.
async function runDueReminders(env: Env): Promise<void> {
  const now = nowIso();
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.text, n.project_id, p.name AS goal_name, p.workspace_id AS ws_id
       FROM nodes n JOIN projects p ON p.id = n.project_id
      WHERE n.due_at IS NOT NULL AND n.due_at <= ? AND n.reminded_at IS NULL AND n.completed_at IS NULL`
  ).bind(now).all<{ id: string; text: string; project_id: string; goal_name: string | null; ws_id: string }>();
  for (const row of results ?? []) {
    const dueNotifId = uid();
    await env.DB.prepare(
      "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, 'goal', ?, ?, ?, ?, ?)"
    )
      .bind(dueNotifId, "期限が来ています", `「${row.goal_name ?? "タスク"}」: ${row.text}`, row.project_id, now, row.ws_id)
      .run();
    await recordRecipients(env, dueNotifId, row.ws_id, row.project_id);
    await env.DB.prepare("UPDATE nodes SET reminded_at = ? WHERE id = ?").bind(now, row.id).run();
    await notifyRealtime(env, row.ws_id);
    await notifyPush(env, row.ws_id, row.project_id, undefined, {
      title: "期限が来ています",
      body: `「${row.goal_name ?? "タスク"}」: ${row.text}`,
      url: `/goals/${row.project_id}`,
    });
  }
}

// Ask the app to run its self-check (it owns the real query functions) and
// raise a notification for the workspace admins when something is broken.
// This exists because every bad bug here failed silently: a query stopped
// returning rows and the UI showed an empty list instead of an error, so the
// only detector was a member eventually complaining.
async function runSelfCheck(env: Env): Promise<void> {
  if (!env.PUSH_URL || !env.PUSH_SECRET) return;
  type Problem = { workspace: string; check: string; detail: string };
  let report: { ok?: boolean; problems?: Problem[] };
  try {
    const doFetch = env.APP ? env.APP.fetch.bind(env.APP) : fetch;
    const r = await doFetch(`${env.PUSH_URL}/api/internal/selfcheck`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-push-secret": env.PUSH_SECRET },
      body: JSON.stringify({}),
    });
    if (!r.ok) { console.log(`[selfcheck] status=${r.status}`); return; }
    report = await r.json();
  } catch (e) {
    console.log(`[selfcheck] threw: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const problems = report.problems ?? [];
  console.log(`[selfcheck] problems=${problems.length}`);
  if (!problems.length) return;

  // one notification per affected workspace, addressed to that workspace's
  // admins so it lands with whoever can actually fix it
  const byWorkspace = new Map<string, Problem[]>();
  for (const p of problems) {
    const list = byWorkspace.get(p.workspace);
    if (list) list.push(p); else byWorkspace.set(p.workspace, [p]);
  }
  for (const [wsName, list] of byWorkspace) {
    const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE name = ? OR id = ? LIMIT 1")
      .bind(wsName, wsName).first<{ id: string }>();
    if (!ws) continue;
    const { results: admins } = await env.DB.prepare(
      `SELECT u.email AS email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND wm.role = 'admin' AND u.email IS NOT NULL`
    ).bind(ws.id).all<{ email: string }>();
    const body = list.map((p) => `${p.check}: ${p.detail}`).join("\n");
    for (const a of admins ?? []) {
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'info', ?, ?, NULL, ?, ?, ?)"
      ).bind(id, "こつこつの自己診断で異常を検知", body, nowIso(), ws.id, a.email.toLowerCase().trim()).run();
      await recordRecipients(env, id, ws.id, null, a.email);
      await notifyPush(env, ws.id, null, [a.email], {
        title: "こつこつの自己診断で異常を検知",
        body: list[0] ? `${list[0].check}: ${list[0].detail}` : "詳細はアプリで確認してください",
        url: "/notifications",
      });
    }
    await notifyRealtime(env, ws.id);
  }
}

// The cron fires every 5 minutes for due reminders; the self-check only needs
// to run once a day, so gate it to the first tick after 00:00 UTC (09:00 JST).
function isDailySelfCheckTick(event: ScheduledEvent): boolean {
  const d = new Date(event.scheduledTime);
  return d.getUTCHours() === 0 && d.getUTCMinutes() < 5;
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
        (req) => memberKeyFromSession(req, env)
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
    const auth = await resolveAuth(request, env);
    if (!auth) {
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

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(rpcError(null, RPC.PARSE_ERROR, "invalid JSON"), 400);
    }

    // Batch support (array of requests).
    if (Array.isArray(payload)) {
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
