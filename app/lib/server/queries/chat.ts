import "server-only";
import { listMembers } from "./members";
import { createNotification, goalNotificationRecipientEmails } from "./notifications";
import { all, first, run, uid, nowIso } from "../db";
import { resolveMentionedMembers } from "../mentions";

// ---------------- chat ----------------
export async function listMessages(goalId: string, wsId: string) {
  return all("SELECT * FROM chat_messages WHERE goal_id = ? AND workspace_id = ? ORDER BY created_at ASC", goalId, wsId);
}
export async function messageCount(goalId: string, wsId: string) {
  const r = await first<{ c: number }>("SELECT COUNT(*) AS c FROM chat_messages WHERE goal_id = ? AND workspace_id = ?", goalId, wsId);
  return r?.c ?? 0;
}
// @name mentions in a comment resolve against every workspace member — not
// just the goal's assignees, so mentioning someone who isn't assigned still
// notifies them (longest name first, so "黒崎優斗" isn't shadowed by a shorter
// coincidental prefix match like "黒崎"). Only mentioned people get notified —
// comments no longer broadcast a notification to everyone with goal access.
async function resolveMentions(wsId: string, body: string) {
  const members = await listMembers(wsId) as { id: string; name: string; email: string | null }[];
  return resolveMentionedMembers(body, members);
}
export async function sendMessage(goalId: string, body: string, wsId: string, role = "user", author = "メンバー", authorEmail: string | null = null) {
  const id = uid();
  await run(
    "INSERT INTO chat_messages (id, goal_id, role, author, author_email, body, workspace_id) VALUES (?,?,?,?,?,?,?)",
    id, goalId, role, author, authorEmail?.toLowerCase().trim() || null, body, wsId
  );
  const mentioned = await resolveMentions(wsId, body);
  const me = authorEmail?.toLowerCase().trim() || null;
  const mentionedEmails = new Set(
    mentioned.map((m) => m.email?.toLowerCase().trim()).filter((e): e is string => !!e)
  );
  const g = await first<{ name: string }>("SELECT name FROM projects WHERE id = ?", goalId);
  for (const email of mentionedEmails) {
    await createNotification(
      { kind: "mention", title: `${author}さんからメンション`, body: `「${g?.name ?? "タスク"}」: ${body}`, goal_id: goalId, targetEmail: email },
      wsId
    );
  }
  // メンションが無いコメントも、そのタスク(と上位ゴール)の担当者には届かせる。
  // 「アサインされている場所の動きは必ず通知」の一部 (2026-09-09 黒崎指示)。
  // 1人ずつ targetEmail で出すので、メンションと同じく本人にだけ届く。
  const watchers = await goalNotificationRecipientEmails(goalId, wsId);
  for (const email of watchers) {
    if (mentionedEmails.has(email)) continue; // メンション通知で既に届いている
    if (me && email === me) continue; // 自分のコメントで自分を鳴らさない
    await createNotification(
      { kind: "info", title: `${author}さんがコメント`, body: `「${g?.name ?? "タスク"}」: ${body}`, goal_id: goalId, targetEmail: email },
      wsId
    );
  }
  return first("SELECT * FROM chat_messages WHERE id = ?", id);
}
export async function getMessage(id: string, wsId: string) {
  return first<{ id: string; goal_id: string | null; author: string | null; author_email: string | null; body: string }>(
    "SELECT * FROM chat_messages WHERE id = ? AND workspace_id = ?", id, wsId
  );
}
export async function updateMessage(id: string, body: string, wsId: string) {
  await run("UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ? AND workspace_id = ?", body, nowIso(), id, wsId);
  return first("SELECT * FROM chat_messages WHERE id = ?", id);
}
export async function deleteMessage(id: string, wsId: string) {
  await run("DELETE FROM chat_messages WHERE id = ? AND workspace_id = ?", id, wsId);
}
