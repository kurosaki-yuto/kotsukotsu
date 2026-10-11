import "server-only";
import { all, first, run, uid, nowIso } from "../db";
import { queuePushToWorkspace, queuePushToMembers } from "../push";
import { notifyWorkspace } from "../realtime";

// ---------------- notifications ----------------
// Goal ids relevant to a member for notification purposes: their own assigned
// goals plus everything under them (assignment propagates DOWN — same rule
// canEditGoal/pruneToAssigned already use: assign the parent, cover the
// children). null = no roster member found; [] = member exists but has no
// assignments at all (sees only goal-less/org-level notifications).
export async function memberRelevantGoalIds(email: string, wsId: string): Promise<string[] | null> {
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", email.toLowerCase().trim(), wsId);
  if (!m) return null;
  const roots = await all<{ goal_id: string }>("SELECT goal_id FROM goal_members WHERE member_id = ?", m.id);
  if (!roots.length) return [];
  // walk down from the member's assignments inside SQL — passing every root id
  // as a bound parameter blows D1's per-query parameter cap once someone holds
  // more than ~100 assignments.
  // UNION (not UNION ALL): a member assigned to both a goal and its subtasks
  // walked the same subtree once per assignment — 3,370万行・15秒 on the real
  // DB, which stalled every other query (login included) behind it.
  const rows = await all<{ id: string }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT p.id FROM projects p JOIN goal_members gm ON gm.goal_id = p.id
        WHERE gm.member_id = ? AND p.workspace_id = ?
       UNION
       SELECT p.id FROM sub CROSS JOIN projects p ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?
     )
     SELECT id FROM sub`,
    m.id, wsId, wsId
  );
  return rows.map((r) => r.id);
}
// The members who should be notified/pushed about an event at goalId: the
// people assigned to that goal. If nobody is assigned to it, the event falls
// up to the NEAREST ancestor that has assignees — an unassigned subtask still
// reaches whoever owns that branch, and stops there.
//
// It used to collect every ancestor's assignees at once. With top-level goals
// assigned to the owner that meant "assigned to a root" = "notified about
// everything in the company", which is what turned this into a notification
// firehose. アサインされている人以外には通知は行かない。
export async function goalNotificationRecipientEmails(goalId: string, wsId: string): Promise<string[]> {
  // アサインされている人には必ず届く — そのタスク本体の担当者と、親から根までの
  // 担当者の全員。以前は最初にアサインが見つかった段で打ち切っていたため、
  // 子タスクに担当が付いた瞬間から親の担当者(自分の顧客ゴールなど)へ通知が
  // 飛ばなくなっていた (2026-09-09 黒崎指摘)。
  const emails = new Set<string>();
  let cur: string | null = goalId;
  let guard = 0;
  while (cur && guard < 30) {
    guard += 1;
    const rows = await all<{ email: string | null }>(
      `SELECT DISTINCT m.email FROM goal_members gm JOIN members m ON m.id = gm.member_id
        WHERE gm.goal_id = ? AND m.workspace_id = ?`,
      cur, wsId
    );
    for (const r of rows) if (r.email) emails.add(r.email.toLowerCase().trim());
    const parentRow: { parent_goal_id: string | null } | null = await first(
      "SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?", cur, wsId
    );
    cur = parentRow?.parent_goal_id ?? null;
  }
  return [...emails];
}
// viewerEmail omitted/null = admin view, unfiltered (admins see everything —
// they need full oversight). Otherwise scoped to memberRelevantGoalIds plus
// goal-less (org-level) notifications, so unassigned members stop getting
// pinged for tasks that have nothing to do with them.
// goal-based visibility clause shared by listNotifications/unreadCount, plus
// its bind args. A row with target_email set (an @mention) is carved out of
// this broadcast rule entirely — only the mentioned person sees it (added by
// the caller as a separate `OR target_email = ?` branch), even if the viewer
// would otherwise qualify via goal assignment.
// The id list is resolved inside SQL rather than bound one id per parameter —
// a member with a large assigned subtree used to push the query past D1's
// bound parameter cap, which made the whole notification list fail.
//
// Two ways a goal-linked row qualifies:
//   1. it was addressed to the viewer when it was sent (notification_recipients
//      — a snapshot, so unassigning someone or moving a task later doesn't
//      retroactively delete notifications they already received). This is the
//      rule for everything sent since migration 0016.
//   2. legacy rows only (no recipient snapshot at all): it hangs off a goal in
//      the viewer's assigned subtree.
// An ancestor branch used to be ORed in here too (notifications from goals
// ABOVE an assignment), and the subtree branch used to apply to every row. Both
// pinged people about work they aren't assigned to — with the top-level goals
// assigned to the owner, that meant everyone under a root heard everything.
// アサインされている人以外に通知は行かない。
async function goalVisibilityClause(viewerEmail: string, wsId: string): Promise<{ clause: string; args: string[] }> {
  const email = viewerEmail.toLowerCase().trim();
  const m = await first<{ id: string }>("SELECT id FROM members WHERE email = ? AND workspace_id = ?", email, wsId);
  if (!m) return { clause: "goal_id IS NULL", args: [] };
  // 再帰の各段は `down CROSS JOIN projects` の順で書く。`projects JOIN down` だと
  // SQLite が projects 側を workspace_id で全件走査し、1段ごとに全タスクを読む
  // (バッジの件数1回で129万行・0.7秒。15秒ごとに叩かれて D1 が詰まり、ログインまで止まった)。
  // CROSS JOIN は結合順を固定するので、parent_goal_id のインデックスで子だけを引く。
  const clause =
    `(goal_id IS NULL
      OR EXISTS (SELECT 1 FROM notification_recipients nrc WHERE nrc.notification_id = n.id AND nrc.email = ?)
      OR (NOT EXISTS (SELECT 1 FROM notification_recipients nra WHERE nra.notification_id = n.id)
      AND goal_id IN (
        WITH RECURSIVE
          down(id) AS (
            SELECT p.id FROM projects p JOIN goal_members gm ON gm.goal_id = p.id
             WHERE gm.member_id = ? AND p.workspace_id = ?
            UNION
            SELECT p.id FROM down CROSS JOIN projects p ON p.parent_goal_id = down.id WHERE p.workspace_id = ?
          )
        SELECT id FROM down)))`;
  return { clause, args: [email, m.id, wsId, wsId] };
}
// 既読はユーザー単位 (notification_reads)。notifications.read_at は旧・全員共有
// 既読の名残で、値が入っている行は「全員既読」として扱い、以後は書かない。
// クライアントには従来通り read_at として見せる(未読なら NULL)ので表示側は無変更。
export type NotifViewer = { email: string; admin: boolean };
const NOTIF_COLS =
  "n.id, n.kind, n.title, n.body, n.goal_id, n.workspace_id, n.target_email, n.created_at, COALESCE(n.read_at, nr.read_at) AS read_at";
const NOTIF_READ_JOIN = "LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.email = ?";
// ページング必須。以前は LIMIT 100 固定で打ち切っていたので、通知が100件を
// 超えたメンバーは古いものが一覧から丸ごと消えていた (実測: 一部メンバーで
// 130件以上が到達不能)。1件多く取って hasMore を返す。
export const NOTIF_PAGE_SIZE = 50;
export async function listNotifications(filter: "all" | "unread", wsId: string, viewer: NotifViewer, offset = 0) {
  const email = viewer.email.toLowerCase().trim();
  const readClause = filter === "unread" ? "n.read_at IS NULL AND nr.notification_id IS NULL AND " : "";
  const page = NOTIF_PAGE_SIZE;
  const rows = viewer.admin
    ? await all(
        `SELECT ${NOTIF_COLS} FROM notifications n ${NOTIF_READ_JOIN} WHERE ${readClause}n.workspace_id = ? ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
        email, wsId, page + 1, offset
      )
    : await (async () => {
        const { clause, args } = await goalVisibilityClause(viewer.email, wsId);
        return all(
          `SELECT ${NOTIF_COLS} FROM notifications n ${NOTIF_READ_JOIN} WHERE ${readClause}n.workspace_id = ? AND ((n.target_email IS NULL AND ${clause}) OR n.target_email = ?) ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
          email, wsId, ...args, email, page + 1, offset
        );
      })();
  const hasMore = rows.length > page;
  return { items: hasMore ? rows.slice(0, page) : rows, hasMore, offset };
}
// ベルのバッジは「まだ見ていないお知らせの数」であって「未読の数」ではない。
// 通知ページを開いたら消えてほしいが、開いただけで全部を既読にすると何が新着
// だったのか分からなくなる (それが元の挙動だった)。開いた時刻を notification_seen
// に記録し、バッジはそれより後に届いた未読だけを数える。一覧側の未読マークは
// read_at ベースのままなので、開くだけでは消えない。
export async function markNotificationsSeen(wsId: string, viewerEmail: string) {
  const email = viewerEmail.toLowerCase().trim();
  await run(
    `INSERT INTO notification_seen (email, workspace_id, seen_at) VALUES (?,?,?)
       ON CONFLICT(email, workspace_id) DO UPDATE SET seen_at = excluded.seen_at`,
    email, wsId, nowIso()
  );
}
const NOTIF_SEEN_CLAUSE =
  "n.created_at > COALESCE((SELECT seen_at FROM notification_seen WHERE email = ? AND workspace_id = ?), '')";
// バッジは「自分に来たお知らせ」の数。管理者も同じ扱いにする — 一覧では全件
// 見えるままだが (オーナーの監督用)、他人宛ての通知でベルが鳴るのは通知洪水の
// もとで、そのせいで自分宛てのメンションが埋もれていた。
export async function unreadCount(wsId: string, viewer: NotifViewer) {
  const email = viewer.email.toLowerCase().trim();
  const { clause, args } = await goalVisibilityClause(viewer.email, wsId);
  const r = await first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM notifications n ${NOTIF_READ_JOIN} WHERE n.read_at IS NULL AND nr.notification_id IS NULL AND ${NOTIF_SEEN_CLAUSE} AND n.workspace_id = ? AND ((n.target_email IS NULL AND ${clause}) OR n.target_email = ?)`,
    email, email, wsId, wsId, ...args, email
  );
  return r?.c ?? 0;
}
export async function markRead(id: string, wsId: string, viewerEmail: string) {
  await run(
    "INSERT OR IGNORE INTO notification_reads (notification_id, email, read_at) SELECT id, ?, ? FROM notifications WHERE id = ? AND workspace_id = ?",
    viewerEmail.toLowerCase().trim(), nowIso(), id, wsId
  );
}
export async function markAllRead(wsId: string, viewer: NotifViewer) {
  const email = viewer.email.toLowerCase().trim();
  let where = "n.workspace_id = ?";
  const args: string[] = [wsId];
  if (!viewer.admin) {
    const v = await goalVisibilityClause(viewer.email, wsId);
    where += ` AND ((n.target_email IS NULL AND ${v.clause}) OR n.target_email = ?)`;
    args.push(...v.args, email);
  }
  await run(
    `INSERT OR IGNORE INTO notification_reads (notification_id, email, read_at) SELECT n.id, ?, ? FROM notifications n WHERE n.read_at IS NULL AND ${where}`,
    email, nowIso(), ...args
  );
}
// Who this notification went out to, frozen at send time. Chunked for the same
// reason every other IN(...) here is: D1 caps bound parameters per query.
async function recordNotificationRecipients(notificationId: string, emails: string[]) {
  const uniq = [...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
  if (!uniq.length) return;
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    await run(
      `INSERT OR IGNORE INTO notification_recipients (notification_id, email) VALUES ${chunk.map(() => "(?,?)").join(",")}`,
      ...chunk.flatMap((e) => [notificationId, e])
    );
  }
}
// Notifications carry a workspace_id. When the notification is tied to a goal we
// derive the workspace from that goal (works for internal callers that only know
// the goal); otherwise the caller passes the active workspace explicitly.
export async function createNotification(n: { kind?: string; title: string; body?: string | null; goal_id?: string | null; targetEmail?: string | null }, wsId?: string) {
  let workspaceId = wsId ?? "default";
  if (n.goal_id) {
    const g = await first<{ workspace_id: string }>("SELECT workspace_id FROM projects WHERE id = ?", n.goal_id);
    // 呼び手のワークスペースと違うゴールには出さない (他社の通知欄・スマホに書けてしまう)
    if (!g) throw new Error("notification goal not found");
    if (wsId && g.workspace_id !== wsId) throw new Error("notification goal is in another workspace");
    workspaceId = g.workspace_id;
  }
  const targetEmail = n.targetEmail?.toLowerCase().trim() || null;
  const id = uid();
  await run(
    "INSERT INTO notifications (id, kind, title, body, goal_id, workspace_id, target_email) VALUES (?,?,?,?,?,?,?)",
    id, n.kind ?? "info", n.title, n.body ?? null, n.goal_id ?? null, workspaceId, targetEmail
  );
  // push to phones for completion / big-goal / assignment / mention events.
  // A targeted notification (@mention) only wakes that one person. Goal-linked
  // untargeted events wake the people connected to that goal (its assignees +
  // any ancestor's assignees), not the whole workspace. Goal-less (org-level)
  // events still go to everyone.
  const kind = n.kind ?? "info";
  // Encrypted payload so the lock screen shows the real content even when the
  // device's app session has expired (no more fixed 「新しい通知があります」).
  const payload = { title: n.title, body: n.body ?? null, url: n.goal_id ? `/goals/${n.goal_id}` : "/notifications" };
  const pushable = kind === "goal" || kind === "streak" || kind === "mention" || kind === "info";
  if (targetEmail) {
    await recordNotificationRecipients(id, [targetEmail]);
    queuePushToMembers(workspaceId, [targetEmail], payload);
  } else if (n.goal_id) {
    // Freeze the audience now. The list query still falls back to the live
    // assignment tree for older rows, but from here on a notification stays
    // visible to whoever it was sent to even if assignments change later.
    const emails = await goalNotificationRecipientEmails(n.goal_id, workspaceId);
    await recordNotificationRecipients(id, emails);
    if (pushable) queuePushToMembers(workspaceId, emails, payload);
  } else if (pushable) {
    // goal-less = workspace-wide; visible to everyone via `goal_id IS NULL`,
    // so there's nothing worth snapshotting.
    queuePushToWorkspace(workspaceId, payload);
  }
  // realtime: nudge connected devices to refetch
  notifyWorkspace(workspaceId);
}
