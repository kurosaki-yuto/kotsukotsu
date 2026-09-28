import "server-only";
import { all, batch, first } from "./db";
import { bucket } from "./files";

// 退会 (アカウント削除)。
//
// 所属しているワークスペースごとに扱いを決める:
//   - 自分しかいない         → ワークスペースごと消す (ゴール・コメント・ファイル含む)
//   - 他にもメンバーがいる   → 自分だけ抜ける。コメントは「退会したメンバー」として残す
//   - 自分が唯一の管理者で、他にメンバーがいる → 退会させない (先に誰かを管理者にしてもらう)
//     管理者のいないワークスペースを作らないため。
//
// 個人情報 (氏名・メール・通知の宛先・招待) は、残るワークスペースからも消す。

export type AccountPlan = {
  purge: { id: string; name: string }[];   // まるごと消えるワークスペース
  leave: { id: string; name: string }[];   // 抜けるだけのワークスペース
  blocked: { id: string; name: string }[]; // 唯一の管理者なので退会できないワークスペース
};

const LEFT_AUTHOR = "退会したメンバー";

export async function accountPlan(userId: string): Promise<AccountPlan> {
  const rows = await all<{ workspace_id: string; role: string; name: string | null; others: number; other_admins: number }>(
    `SELECT wm.workspace_id, wm.role, w.name,
            (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = wm.workspace_id AND o.user_id != wm.user_id) AS others,
            (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = wm.workspace_id AND o.user_id != wm.user_id AND o.role = 'admin') AS other_admins
       FROM workspace_members wm LEFT JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      ORDER BY wm.joined_at`,
    userId
  );
  const plan: AccountPlan = { purge: [], leave: [], blocked: [] };
  for (const r of rows) {
    const ws = { id: r.workspace_id, name: r.name || r.workspace_id };
    if (r.others === 0) plan.purge.push(ws);
    else if (r.role === "admin" && r.other_admins === 0) plan.blocked.push(ws);
    else plan.leave.push(ws);
  }
  return plan;
}

/** 退会を実行する。blocked があるときは何もせず plan を返す。 */
export async function deleteAccount(userId: string, email: string): Promise<{ ok: boolean; plan: AccountPlan }> {
  const plan = await accountPlan(userId);
  if (plan.blocked.length) return { ok: false, plan };
  const mail = email.toLowerCase().trim();

  const stmts: { sql: string; args?: unknown[] }[] = [];

  for (const ws of plan.purge) {
    const w = ws.id;
    stmts.push(
      { sql: "DELETE FROM notification_recipients WHERE notification_id IN (SELECT id FROM notifications WHERE workspace_id = ?)", args: [w] },
      { sql: "DELETE FROM notification_reads WHERE notification_id IN (SELECT id FROM notifications WHERE workspace_id = ?)", args: [w] },
      { sql: "DELETE FROM notifications WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM notification_seen WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM chat_messages WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM resources WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM goal_next_action WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM today_briefs WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM done_log WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM nodes WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM projects WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM members WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM invites WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM mcp_instruction_delivery WHERE ws_id = ?", args: [w] },
      { sql: "DELETE FROM workspace_members WHERE workspace_id = ?", args: [w] },
      { sql: "DELETE FROM workspaces WHERE id = ?", args: [w] },
    );
  }

  for (const ws of plan.leave) {
    const w = ws.id;
    stmts.push(
      // コメントはチームの記録なので残す。書いた人だけ分からなくする。
      { sql: "UPDATE chat_messages SET author = ?, author_email = NULL WHERE workspace_id = ? AND lower(author_email) = ?", args: [LEFT_AUTHOR, w, mail] },
      // 名簿の行を消すと、担当 (goal_members / node_members) も外部キーで一緒に消える
      { sql: "DELETE FROM members WHERE workspace_id = ? AND lower(email) = ?", args: [w, mail] },
      { sql: "DELETE FROM invites WHERE workspace_id = ? AND lower(email) = ?", args: [w, mail] },
      { sql: "DELETE FROM notification_recipients WHERE lower(email) = ? AND notification_id IN (SELECT id FROM notifications WHERE workspace_id = ?)", args: [mail, w] },
      { sql: "DELETE FROM notification_reads WHERE lower(email) = ? AND notification_id IN (SELECT id FROM notifications WHERE workspace_id = ?)", args: [mail, w] },
      { sql: "DELETE FROM notifications WHERE workspace_id = ? AND lower(target_email) = ?", args: [w, mail] },
      { sql: "DELETE FROM notification_seen WHERE workspace_id = ? AND lower(email) = ?", args: [w, mail] },
      { sql: "DELETE FROM today_briefs WHERE workspace_id = ? AND lower(member_email) = ?", args: [w, mail] },
      { sql: "DELETE FROM mcp_instruction_delivery WHERE ws_id = ? AND actor_key IN (?, ?)", args: [w, mail, userId] },
      { sql: "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?", args: [w, userId] },
    );
  }

  // 残るデータから、消える利用者の id への参照を外す
  stmts.push(
    { sql: "UPDATE projects SET created_by = NULL WHERE created_by = ?", args: [userId] },
    { sql: "UPDATE workspaces SET created_by = NULL WHERE created_by = ?", args: [userId] },
    { sql: "UPDATE invites SET created_by = NULL WHERE created_by = ?", args: [userId] },
    { sql: "UPDATE invites SET accepted_user_id = NULL WHERE accepted_user_id = ?", args: [userId] },
    { sql: "DELETE FROM push_subscriptions WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM password_resets WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM users WHERE id = ?", args: [userId] },
  );

  // 環境によって存在しないテーブルがある (ローカルの D1 には後から足したテーブルが無い等)。
  // 1つでも無いテーブルを含むとバッチ全体が失敗するので、あるテーブルだけに絞る。
  const existing = new Set(
    (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name)
  );
  const runnable = stmts.filter((st) => {
    const m = st.sql.match(/^(?:DELETE FROM|UPDATE)\s+(\w+)/);
    return !m || existing.has(m[1]);
  });

  // 途中で失敗して半端に消えた状態を作らないよう、1回のバッチ (トランザクション) で流す
  await batch(runnable);

  // ファイル本体 (R2) はワークスペースごとのキー接頭辞で置いてある。DB を消し終えてから片付ける
  // (先に消すと、DB 側が失敗したときに参照だけ残ったファイルの無い資料ができる)。
  const b = bucket();
  if (b) {
    for (const ws of plan.purge) {
      let cursor: string | undefined;
      do {
        const listed = await b.list({ prefix: `${ws.id}/`, cursor });
        if (listed.objects.length) await b.delete(listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
  }

  // 念のため、本当に消えたかを確かめる
  const left = await first<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE id = ?", userId);
  return { ok: (left?.c ?? 0) === 0, plan };
}
