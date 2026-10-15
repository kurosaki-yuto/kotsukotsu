// Worker の bindings と、ツール名の集合 (変更系・プッシュ対象)。
export interface Env {
  DB: D1Database;
  /** Workers AI。型の意味での検索 (埋め込み) に使う。無い環境では言葉の重なりで選ぶ。 */
  AI?: Ai;
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
  /** 顧客台帳 (kotsukotsu-crm)。無い環境 (公開版など) では顧客台帳のツールを並べない。src/crm.ts */
  CRM?: Fetcher;
  /** 顧客台帳への取り次ぎを照合する値。顧客台帳の SERIES_SECRET と同じ値。 */
  SERIES_SECRET?: string;
  /** 型を外 (GitHub) に書き出す先 "owner/repo" とトークン (secret)。無ければ書き出さない。app/lib/server/templateCore.ts */
  KATA_GITHUB_REPO?: string;
  KATA_GITHUB_TOKEN?: string;
  KATA_GITHUB_BRANCH?: string;
}

// Tools that change data — after these run, nudge the realtime worker so every
// connected device refetches instantly.
export const MUTATING_TOOLS = new Set([
  "create_goal", "update_goal", "move_goal", "add_subtask", "start_task", "complete_subtask", "set_today",
  "send_chat", "edit_chat", "delete_chat", "create_notification", "assign_member_to_goal",
  "unassign_member_from_goal", "set_member_role", "create_invite", "upload_file",
  "create_template", "update_template", "archive_template", "apply_template",
  "propose_template_change", "revert_template_change", "link_playbook_to_template", "record_template_export",
]);
// Subset of MUTATING_TOOLS worth waking a phone for (mirrors the app's own
// push-eligible notification kinds: goal/streak/mention/info — see
// app/lib/server/queries.ts createNotification). Structural edits (move,
// rename, scheduling) stay realtime-only so AI bookkeeping doesn't spam phones.
// send_chat is absent on purpose: its handler decides the audience itself
// (@mentioned people + the task's/上位ゴールの担当者) and pushes to exactly
// those members instead of the generic goal-assignee push here.
export const PUSH_TOOLS = new Set([
  "complete_subtask", "create_notification", "assign_member_to_goal", "upload_file", "apply_template",
]);
// 子を足した・移した先の親は一番下ではなくなるので、進行中を外す (app の clearStartedOnParent と同じ)
