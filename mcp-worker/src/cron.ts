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
