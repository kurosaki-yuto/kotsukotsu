// ツールが共有する部品: 通知・認証・スコープ/権限・RPC の応答・タスク進捗。
import { type ZodType } from "zod";
import { resolveMentionedMembers } from "../../app/lib/server/mentions";
import { parseTemplateRow, type TemplateRow } from "../../app/lib/server/templateCore";
import { safeEqual } from "../../app/lib/server/compare";
import { Env } from "./env";

export async function clearStartedOnParent(env: Env, wsId: string, parentId: string | null): Promise<void> {
  if (!parentId) return;
  await env.DB.prepare(
    "UPDATE projects SET started_at = NULL, started_by = NULL, started_by_name = NULL, started_via = NULL WHERE id = ? AND workspace_id = ? AND started_at IS NOT NULL"
  ).bind(parentId, wsId).run();
}

export async function notifyRealtime(env: Env, wsId: string): Promise<void> {
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
export type PushPayload = { title: string; body?: string | null; url?: string | null };
export async function notifyPush(env: Env, wsId: string, goalId?: string | null, emails?: string[], payload?: PushPayload | null): Promise<void> {
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
export async function goalWatcherEmails(env: Env, wsId: string, goalId: string): Promise<string[]> {
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

export async function recordRecipients(env: Env, notificationId: string, wsId: string, goalId: string | null, targetEmail?: string | null): Promise<void> {
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

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

// 「タスクを作った人がそのタスクの担当」— これが基本ルール (2026-09-08 黒崎指示)。
// 誰が作ったのかを user 単位で決める。
// - メンバーキー (auth.actor あり) → その本人
// - ワークスペースキー (auth.actor なし) → そのワークスペースの持ち主。
//   workspaces.created_by、無ければ workspace_members の admin のうち最古参。
//   ワークスペースキーは持ち主が自分の AI に持たせている鍵なので、そこから
//   作られたタスクの作成者は持ち主本人とみなすのが実態に合う。
export type CreatorUser = { userId: string; name: string; email: string };

export async function resolveCreator(env: Env, wsId: string, actor: McpAuth["actor"]): Promise<CreatorUser | null> {
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
export async function memberIdForUser(env: Env, wsId: string, user: CreatorUser, isAdmin: boolean): Promise<string> {
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
export async function assignCreatorAsHolder(env: Env, wsId: string, goalId: string, actor: McpAuth["actor"]): Promise<string | null> {
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
export async function inheritAssigneeFromAncestors(env: Env, wsId: string, goalId: string, parentId: string | null): Promise<string | null> {
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
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB, same cap as the app's /api/files
export function safeFileName(name: string): string {
  return (name || "file").normalize("NFC").replace(/[^\p{L}\p{N}._\-]+/gu, "_").replace(/^\.+/, "_").slice(0, 80);
}
export function decodeBase64(b64: string): Uint8Array {
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
export function formatFieldText(text: string): string {
  let t = text.replace(/\r\n/g, "\n");
  const hadBreaks = t.includes("\n");
  t = t.replace(/(?<!\n)[ \t]*□/g, "\n□");
  if (!hadBreaks) t = t.replace(/。(?![\n)）」』])/g, "。\n");
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
// 「今日」は UTC で出してはいけない。JST の朝9時より前は前日になり、「今日やる
// こと」が1日ずれる。ワークスペースのタイムゾーンで解釈する workspaceToday()
// (src/today.ts) を使う。以前あった todayIso() は UTC 固定だったので消した。


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
export type McpAuth = {
  wsId: string;
  scopeRoots: string[] | null;
  actor: { userId: string; name: string; email: string | null; role: string } | null;
};

export type Membership = { workspace_id: string; user_id: string; role: string; scope_goal_id: string | null; name: string | null; email: string | null };

/** One workspace_members row → the auth that member has in that workspace. */
export async function membershipAuth(env: Env, mem: Membership): Promise<McpAuth> {
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

/** Workspaces the connected person belongs to (member tokens only — a
 *  workspace key is one workspace by definition). */
export async function reachableWorkspaces(env: Env, auth: McpAuth): Promise<{ id: string; name: string; role: string }[]> {
  if (!auth.actor) {
    const w = await env.DB.prepare("SELECT id, name FROM workspaces WHERE id = ?").bind(auth.wsId).first<{ id: string; name: string }>();
    return [{ id: auth.wsId, name: w?.name ?? auth.wsId, role: "admin" }];
  }
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.name, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? ORDER BY wm.joined_at ASC`
  ).bind(auth.actor.userId).all<{ id: string; name: string; role: string }>();
  return results ?? [];
}

/**
 * One connection, many workspaces: a tool call may name another workspace
 * (id or name) the same person belongs to. The connection's own workspace is
 * the default. The person's role/scope in the target workspace applies — the
 * connection's rights never carry over.
 */
export async function authForWorkspace(env: Env, base: McpAuth, ref: unknown): Promise<McpAuth> {
  const want = typeof ref === "string" ? ref.trim() : "";
  if (!want || want === base.wsId) return base;
  const reachable = await reachableWorkspaces(env, base);
  const names = reachable.map((w) => `${w.name} (${w.id})`).join("、");
  if (!base.actor) {
    throw new Error(`この接続はワークスペースキーなので「${reachable[0]?.name}」だけを扱えます。複数のワークスペースを使うには、キー無しの接続用URL (本人のログイン) か本人のAPIキーで繋いでください`);
  }
  let hits = reachable.filter((w) => w.id === want);
  if (!hits.length) hits = reachable.filter((w) => w.name === want);
  if (!hits.length) hits = reachable.filter((w) => w.name.toLowerCase().includes(want.toLowerCase()));
  if (hits.length !== 1) {
    throw new Error(hits.length === 0
      ? `ワークスペース「${want}」に所属していません。使えるワークスペース: ${names}`
      : `「${want}」に当たるワークスペースが複数あります: ${hits.map((w) => `${w.name} (${w.id})`).join("、")}。id で指定してください`);
  }
  const mem = await env.DB.prepare(
    `SELECT wm.workspace_id, wm.user_id, wm.role, wm.scope_goal_id, u.name, u.email
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? AND wm.user_id = ?`
  ).bind(hits[0].id, base.actor.userId).first<Membership>();
  if (!mem) throw new Error(`ワークスペース「${want}」に所属していません。使えるワークスペース: ${names}`);
  return membershipAuth(env, mem);
}

export async function resolveAuth(req: Request, env: Env): Promise<McpAuth | null> {
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
    ).bind(presented).first<Membership>();
    if (mem) return membershipAuth(env, mem);
  } catch { /* column may not exist yet */ }
  // 4) Legacy fallback: org_settings singleton key → default workspace.
  try {
    const row = await env.DB.prepare("SELECT mcp_token FROM org_settings WHERE id = 1").first<{ mcp_token: string | null }>();
    if (row?.mcp_token && safeEqual(presented, row.mcp_token)) return { wsId: "default", scopeRoots: null, actor: null };
  } catch { /* column may not exist yet */ }
  return null;
}


/** list_my_tasks / list_my_turn の「誰の」。member (名前・姓だけ・メール) → 接続している本人。
 *  名前はコメントの @メンションと同じ照合。0件・複数件はメンバー名を添えてエラーにする。 */
export async function resolveWho(env: Env, wsId: string, auth: McpAuth, who: string): Promise<{ email: string; name: string | null }> {
  if (who) {
    const { results: roster } = await env.DB.prepare(
      "SELECT id, name, email FROM members WHERE workspace_id = ?"
    ).bind(wsId).all<{ id: string; name: string | null; email: string | null }>();
    const list = (roster ?? []).map((m) => ({ id: m.id, name: m.name ?? "", email: m.email }));
    const byEmail = list.filter((m) => m.email && m.email.toLowerCase() === who.toLowerCase());
    const hits = byEmail.length ? byEmail : resolveMentionedMembers(`@${who.replace(/^@/, "")}`, list);
    const withMail = hits.filter((m) => m.email);
    if (withMail.length !== 1) {
      const names = list.map((m) => m.name).filter(Boolean).join("、");
      throw new Error(withMail.length === 0
        ? `「${who}」に当たるメンバーがいません。メンバー: ${names}`
        : `「${who}」に当たるメンバーが複数います: ${withMail.map((m) => m.name).join("、")}。フルネームかメールで指定してください`);
    }
    return { email: withMail[0].email!, name: withMail[0].name };
  }
  const email = (auth.actor?.email || "").trim();
  if (!email) throw new Error("誰のタスクか分かりません。member に名前かメールを渡してください (ワークスペース全体のキーで繋いでいるとき)");
  // 名簿の表示名を優先 (ボールの行に書かれる名前と合わせる)
  const row = await env.DB.prepare("SELECT name FROM members WHERE workspace_id = ? AND lower(email) = lower(?)").bind(wsId, email).first<{ name: string | null }>();
  return { email, name: row?.name || auth.actor?.name || null };
}

// ---- scope enforcement helpers -------------------------------------------

/** Is goalId inside the auth's scope? A null scope = the whole workspace.
 * In scope = the goal is one of the scope roots or a descendant of one. */
export async function goalInScope(env: Env, auth: McpAuth, goalId: string): Promise<boolean> {
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
export async function assertGoalInScope(env: Env, auth: McpAuth, goalId: string): Promise<void> {
  if (!(await goalInScope(env, auth, goalId))) throw new Error(`goal not found: ${goalId}`);
}

/** Look up a node's goal and assert it is inside the scope. */
export async function assertNodeInScope(env: Env, auth: McpAuth, nodeId: string): Promise<void> {
  if (!auth.scopeRoots) return;
  const n = await env.DB.prepare("SELECT project_id FROM nodes WHERE id = ? AND workspace_id = ?")
    .bind(nodeId, auth.wsId).first<{ project_id: string }>();
  if (!n) throw new Error(`node not found: ${nodeId}`);
  await assertGoalInScope(env, auth, n.project_id);
}

/** Workspace-token sessions (actor null) have admin rights; member tokens need role=admin. */
export function assertAdmin(auth: McpAuth): void {
  if (auth.actor && auth.actor.role !== "admin") throw new Error("管理者権限が必要です (このAPIキーはメンバー権限です)");
}

// 編集権限 (アプリの canEditGoal と同じ規則): 管理者 (ワークスペースキー含む) / そのゴールか上位ゴールの作成者 /
// そのゴールか上位ゴールに can_edit=1 で担当になっている人。以前はスコープ (見えるか) だけで書けていた。
export async function canEditGoal(env: Env, wsId: string, auth: McpAuth, goalId: string): Promise<boolean> {
  if (!auth.actor || auth.actor.role === "admin") return true;
  const email = (auth.actor.email ?? "").toLowerCase().trim();
  const m = email
    ? await env.DB.prepare("SELECT id FROM members WHERE workspace_id = ? AND lower(email) = ?").bind(wsId, email).first<{ id: string }>()
    : null;
  let cur: string | null = goalId;
  let guard = 0;
  while (cur && guard++ < 50) {
    const node: { created_by: string | null; parent_goal_id: string | null } | null = await env.DB
      .prepare("SELECT created_by, parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?")
      .bind(cur, wsId).first<{ created_by: string | null; parent_goal_id: string | null }>();
    if (!node) return false;
    if (node.created_by && node.created_by === auth.actor.userId) return true;
    if (m) {
      const gm = await env.DB.prepare("SELECT can_edit FROM goal_members WHERE goal_id = ? AND member_id = ?").bind(cur, m.id).first<{ can_edit: number }>();
      if (gm && gm.can_edit === 1) return true;
    }
    cur = node.parent_goal_id;
  }
  return false;
}
export async function assertCanEdit(env: Env, wsId: string, auth: McpAuth, goalId: string): Promise<void> {
  if (!(await canEditGoal(env, wsId, auth, goalId))) {
    throw new Error("このゴールを編集する権限がありません (閲覧のみの担当です。編集が要るなら管理者に担当の「編集を許可」を頼んでください)");
  }
}
// 担当の付け外し (アプリの canManage と同じ): 管理者か、そのゴールの作成者だけ
export async function assertCanManage(env: Env, wsId: string, auth: McpAuth, goalId: string): Promise<void> {
  if (!auth.actor || auth.actor.role === "admin") return;
  const g = await env.DB.prepare("SELECT created_by FROM projects WHERE id = ? AND workspace_id = ?").bind(goalId, wsId).first<{ created_by: string | null }>();
  if (g?.created_by && g.created_by === auth.actor.userId) return;
  throw new Error("担当を変えられるのは管理者かそのゴールの作成者だけです");
}

// 型 (テンプレート) を id か名前で引く。名前は完全一致 → 部分一致。0 件・複数件はエラー。
export async function findTemplate(env: Env, wsId: string, ref: string) {
  const byId = await env.DB.prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ? AND archived_at IS NULL").bind(ref, wsId).first<TemplateRow>();
  if (byId) return parseTemplateRow(byId);
  const { results } = await env.DB.prepare("SELECT * FROM templates WHERE workspace_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200").bind(wsId).all<TemplateRow>();
  const all = results ?? [];
  const q = ref.trim().toLowerCase();
  const exact = all.filter((t) => t.name.trim().toLowerCase() === q);
  const hits = exact.length ? exact : all.filter((t) => t.name.toLowerCase().includes(q));
  if (hits.length === 1) return parseTemplateRow(hits[0]);
  if (!hits.length) throw new Error(`型が見つかりません: ${ref}。list_templates で一覧を確認してください`);
  throw new Error(`「${ref}」に当たる型が複数あります: ${hits.map((t) => t.name).join("、")}。id で指定してください`);
}

// 型を直せるのは管理者 (ワークスペースキー含む) と作った本人
export function assertTemplateManager(auth: McpAuth, t: { created_by: string | null }): void {
  if (!auth.actor || auth.actor.role === "admin") return;
  if (t.created_by && t.created_by === auth.actor.userId) return;
  throw new Error("この型を直せるのは管理者か作った本人です");
}

// A comment may only be edited/deleted by whoever posted it: member tokens
// match on author_email (fallback: display name for pre-author_email rows),
// the workspace key matches its own shared-key persona posts. Editing someone
// else's words through MCP is never allowed — that's speech in their name.
export function assertOwnMessage(auth: McpAuth, msg: { author: string | null; author_email: string | null }): void {
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
export const SUBTREE_CTE = `WITH RECURSIVE sub(id) AS (
  SELECT id FROM projects WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))
  UNION
  SELECT p.id FROM sub s CROSS JOIN projects p ON p.parent_goal_id = s.id
)`;

export function jsonResponse(body: unknown, status = 200, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(), ...(extra ?? {}) },
  });
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  };
}

// JSON-RPC error codes
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
export function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// args はツールごとに zod で検査したあとの値。型は各ツールの schema が持つので、ここは any でよい
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** workspaceGiven: 呼び出しで workspace を明示したか (list_my_tasks / list_my_turn は、明示が無ければ所属する全ワークスペースから集める) */
export type ToolCtx = { workspaceGiven: boolean };
export type ToolHandler = (args: any, env: Env, wsId: string, auth: McpAuth, ctx?: ToolCtx) => Promise<unknown>;
export interface ToolDef {
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: ZodType<any>;
  handler: ToolHandler;
}

/** Wrap a value as MCP tool result content (JSON text). */
export function toolText(value: unknown) {
  // Compact JSON — clients parse this, they don't read it raw, and pretty-printing
  // roughly triples payload size on large list_* results for no benefit.
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// list_goals/list_subtasks are browse views — leave out current_state/completion_criteria
// (long free text, fetched individually via get_goal) so bulk listing doesn't blow the payload.
export const GOAL_LIST_COLUMNS =
  "id, name, order_idx, created_at, emoji, deadline, owner, status, parent_goal_id, started_at, started_by_name, started_via";

// ---- タスクと現状の連動 ----
// 人は現状を書き換えないので、AI がタスクを動かしたついでに書き換える。そのための材料:
// 直下のタスクの今の状態と、「タスクが動いた後に現状が書き換えられたか」。
export async function taskProgress(env: Env, wsId: string, goalId: string): Promise<{ text: string; stale: boolean }> {
  const [kidsRes, self, ws] = await Promise.all([
    env.DB.prepare(
      `SELECT name, status, deadline, completed_at, created_at, started_at, started_by_name, started_via FROM projects
        WHERE parent_goal_id = ? AND workspace_id = ? AND status != 'archived' ORDER BY order_idx ASC, created_at ASC`
    ).bind(goalId, wsId).all<{ name: string | null; status: string; deadline: string | null; completed_at: string | null; created_at: string | null; started_at: string | null; started_by_name: string | null; started_via: string | null }>(),
    env.DB.prepare("SELECT state_updated_at, criteria_updated_at FROM projects WHERE id = ? AND workspace_id = ?")
      .bind(goalId, wsId).first<{ state_updated_at: string | null; criteria_updated_at: string | null }>(),
    env.DB.prepare("SELECT timezone FROM workspaces WHERE id = ?").bind(wsId).first<{ timezone: string | null }>(),
  ]);
  const kids = kidsRes.results;
  const tz = ws?.timezone || "Asia/Tokyo";
  const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
  const md = (iso: string | null) => (iso ? day(iso.length <= 10 ? iso + "T00:00:00Z" : iso).slice(5).replace("-", "/") : "記録なし");
  const today = day(new Date().toISOString());
  const done = kids.filter((k) => k.status === "done");
  const open = kids.filter((k) => k.status !== "done");
  const overdue = open.filter((k) => k.deadline && k.deadline.slice(0, 10) < today).length;
  // 「進んだ」と数えるのは完了だけ。タスクを登録しただけでは現状は変わらない。
  let last: string | null = null;
  for (const k of done) if (k.completed_at && (!last || k.completed_at > last)) last = k.completed_at;
  const stateAt = self?.state_updated_at ?? null;
  const stale = !!last && (!stateAt || last > stateAt);
  const lines = [`${today} 時点の直下のタスク`];
  if (kids.length === 0) lines.push("タスクなし");
  else {
    lines.push(`${done.length}/${kids.length} 完了、残り ${open.length}${overdue ? ` (期限切れ ${overdue})` : ""}`);
    const recent = done.filter((k) => k.completed_at).sort((a, b) => (b.completed_at! > a.completed_at! ? 1 : -1)).slice(0, 3);
    if (recent.length) lines.push("最近の完了: " + recent.map((k) => `${md(k.completed_at)} ${(k.name ?? "").trim()}`).join(" / "));
    const doing = open.filter((k) => k.started_at);
    if (doing.length) lines.push("進行中: " + doing.slice(0, 3).map((k) => `${(k.name ?? "").trim()} (${(k.started_by_name ?? "不明").trim()}${k.started_via && k.started_via !== "app" ? `・${k.started_via}` : ""}、${md(k.started_at)}から)`).join(" / "));
    if (open.length) lines.push("次の未完了: " + open.slice(0, 3).map((k) => (k.name ?? "").trim() + (k.deadline ? ` (期限 ${md(k.deadline)})` : "")).join(" / "));
  }
  lines.push(`完了の基準を書き換えた日: ${md(self?.criteria_updated_at ?? null)} / 現状を書き換えた日: ${md(stateAt)}`);
  return { text: lines.join("\n"), stale };
}

/** タスクを足した・閉じたあとに返す。閉じたとき (nudge) に親の現状が古ければ、書き直す指示を付ける。 */
export async function parentStateNote(env: Env, wsId: string, parentId: string, nudge = false) {
  const p = await taskProgress(env, wsId, parentId);
  if (!nudge || !p.stale) return { parent_task_progress: p.text };
  return {
    parent_task_progress: p.text,
    next_action:
      `親ゴール (${parentId}) の現状がタスクの動きより古い。このターンのうちに get_goal で親を読み、` +
      "update_goal で current_state を今の状態 (日付 / 済んだこと / ボール / 残り・詰まり) に書き直す。" +
      "今回の結果で「何が満たされたら完了か」が変わったなら、先に completion_criteria を直す。",
  };
}
