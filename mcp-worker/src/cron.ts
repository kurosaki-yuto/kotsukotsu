// 定期実行 (期限リマインド・自己診断)。

// ---------------------------------------------------------------------------
// Cron: due-date reminders (wrangler.jsonc triggers.crons)
// ---------------------------------------------------------------------------
// Sweeps every node with a due_at that has arrived and hasn't reminded yet,
// fires one notification per task (targeted the same way any goal-linked
// event is — everyone assigned to that goal), marks it reminded_at so the
// next sweep skips it, and wakes phones for that goal.
import { Env } from "./env";
import { notifyPush, notifyRealtime, nowIso, recordRecipients, uid } from "./lib";
import { sweepStalled } from "../../app/lib/stall";
import { parseTemplateRow, scheduleOccurrence, applyTemplate, normalizeValues, missingRequiredInputs, substitute, describeSchedule, type Template, type TemplateRow } from "../../app/lib/server/templateCore";
import { localDate } from "./today";
export async function runDueReminders(env: Env): Promise<void> {
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
export async function runSelfCheck(env: Env): Promise<void> {
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
export function isDailySelfCheckTick(event: ScheduledEvent): boolean {
  const d = new Date(event.scheduledTime);
  return d.getUTCHours() === 0 && d.getUTCMinutes() < 5;
}

// 進行中のまま24時間動かなかったタスクを「止まっている」に切り替える (app/lib/stall.ts)。
// 5分ごとの cron のうち、毎時0〜4分の1回だけ回す。画面を開いたときにもそのワークスペース分を回している。
export async function runStallSweep(env: Env, event: ScheduledEvent): Promise<void> {
  const d = new Date(event.scheduledTime);
  if (d.getUTCMinutes() >= 5) return;
  const n = await sweepStalled(env.DB as never, d);
  if (n) console.log(`[stall] marked ${n} task(s) as stalled`);
}

// ---------------------------------------------------------------------------
// 型の繰り返し (templates.schedule、黒崎判断 2026-11-02)
// ---------------------------------------------------------------------------
// 時刻になった型を、保存した振る先 (schedule_target) に「振る」と同じ処理で振り、担当の今日に入れて知らせる。
// 前回分のゴールがまだ終わっていなければ作らず、前回分のゴールに「残っています」と知らせる (二重に積まない)。
// 手を動かすのは AI の定期実行 (routineSetupText)。ここはタスクを作るまで。
// 同じ回を二度振らないよう、last_run_key を条件つき UPDATE で先に取ってから振る (Cloudflare と Docker の cron が重なっても1回)。
export async function runTemplateSchedules(env: Env, at: Date = new Date()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT t.*, COALESCE(NULLIF(trim(w.timezone), ''), 'Asia/Tokyo') AS tz
       FROM templates t LEFT JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.schedule IS NOT NULL AND t.archived_at IS NULL
      ORDER BY t.id LIMIT 500`
  ).all<TemplateRow & { tz: string }>();
  let made = 0;
  for (const row of results ?? []) {
    const t = parseTemplateRow(row);
    if (!t.schedule) continue;
    const key = scheduleOccurrence(t.schedule, at, row.tz);
    if (!key || row.last_run_key === key) continue;
    const now = nowIso();
    const claimed = await env.DB.prepare(
      "UPDATE templates SET last_run_key = ?, last_run_at = ? WHERE id = ? AND workspace_id = ? AND (last_run_key IS NULL OR last_run_key != ?)"
    ).bind(key, now, t.id, t.workspace_id, key).run();
    if (!claimed.meta.changes) continue;
    try {
      if (await runOneSchedule(env, t, row.tz, row.last_run_goal_id ?? null, now)) made++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[template-schedule] ${t.id}: ${msg}`);
      await notifyTemplateOwner(env, t, `型「${t.name}」を繰り返しで振れませんでした`, `${msg}。型の画面で振る先を直してください`, t.schedule_target?.parent_id ?? null, now);
    }
  }
  return made;
}

async function runOneSchedule(env: Env, t: Template, tz: string, lastGoalId: string | null, now: string): Promise<boolean> {
  const wsId = t.workspace_id;
  if (lastGoalId) {
    const prev = await env.DB.prepare("SELECT id, name, status FROM projects WHERE id = ? AND workspace_id = ?").bind(lastGoalId, wsId)
      .first<{ id: string; name: string; status: string }>();
    if (prev && prev.status === "active") {
      const id = uid();
      const title = `型「${t.name}」の前回分が終わっていません`;
      const body = `「${prev.name}」が開いたままなので、今回分は作りませんでした。前回分を終えると次の回から振られます`;
      await env.DB.prepare("INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, 'goal', ?, ?, ?, ?, ?)")
        .bind(id, title, body, prev.id, now, wsId).run();
      await recordRecipients(env, id, wsId, prev.id);
      await notifyPush(env, wsId, prev.id, undefined, { title, body, url: `/goals/${prev.id}` });
      return false;
    }
  }
  const target = t.schedule_target;
  if (!target) throw new Error("振る先 (置き場所と担当) が入っていません");
  const member = await env.DB.prepare("SELECT id, name, email FROM members WHERE id = ? AND workspace_id = ?").bind(target.member_id, wsId)
    .first<{ id: string; name: string; email: string | null }>();
  if (!member) throw new Error("振る先の担当がメンバーにいません");
  const values = normalizeValues(target.values, t.inputs);
  const missing = missingRequiredInputs(t.inputs, values);
  if (missing.length) throw new Error(`必須の入力が空です: ${missing.join("、")}`);
  const today = localDate(new Date(now), tz);
  const deadline = target.deadline_days !== undefined
    ? new Date(Date.parse(`${today}T00:00:00Z`) + target.deadline_days * 86400000).toISOString().slice(0, 10)
    : null;
  const { rootId, created } = await applyTemplate(env.DB, wsId, t, {
    parentId: target.parent_id,
    memberId: member.id,
    memberName: member.name,
    values,
    creatorUserId: t.created_by,
    creatorName: `繰り返し (${describeSchedule(t.schedule)})`,
    deadline,
    now,
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET today_date = ? WHERE id = ? AND workspace_id = ?").bind(today, rootId, wsId),
    env.DB.prepare("UPDATE templates SET last_run_goal_id = ? WHERE id = ? AND workspace_id = ?").bind(rootId, t.id, wsId),
  ]);
  const name = substitute(t.name, values) || t.name;
  const title = `型「${name}」の今回分が振られました`;
  const body = `${describeSchedule(t.schedule)} の繰り返し → ${member.name}。タスク ${created} 件`;
  if (member.email) {
    const id = uid();
    await env.DB.prepare("INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'mention', ?, ?, ?, ?, ?, ?)")
      .bind(id, title, body, rootId, now, wsId, member.email.toLowerCase()).run();
    await recordRecipients(env, id, wsId, rootId, member.email);
    await notifyPush(env, wsId, rootId, [member.email.toLowerCase()], { title, body, url: `/goals/${rootId}` });
  }
  await notifyRealtime(env, wsId);
  return true;
}

// 振れなかったことを型を作った人に知らせる (作った人がいなければ管理者全員が見るワークスペースの通知)
async function notifyTemplateOwner(env: Env, t: Template, title: string, body: string, goalId: string | null, now: string): Promise<void> {
  const owner = t.created_by
    ? await env.DB.prepare("SELECT lower(email) AS email FROM users WHERE id = ?").bind(t.created_by).first<{ email: string | null }>()
    : null;
  const id = uid();
  await env.DB.prepare("INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'info', ?, ?, ?, ?, ?, ?)")
    .bind(id, title, body, goalId, now, t.workspace_id, owner?.email ?? null).run();
  await recordRecipients(env, id, t.workspace_id, goalId, owner?.email ?? null);
}
