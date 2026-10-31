// 「進行中」のまま放置されたタスクを「止まっている」に切り替える (2026-11-01)。
// 進行中の印 (started_at) には期限が無く、セッションが落ちても別の日になっても残っていた
// (11/1 時点で31件、最古は27日前)。最後に動いてから STALL_HOURS 時間たったものは進行中を外し、
// 誰がいつ始めて止まったかを stalled_note に残す。画面 (/api/attention) と MCP の cron の両方から呼ぶ。
// 「動いた」= 開始・現状の更新・作業の手順の追加/チェック のどれか。

export const STALL_HOURS = 24;

type DB = {
  prepare(sql: string): { bind(...args: unknown[]): { all<T>(): Promise<{ results?: T[] }>; run(): Promise<unknown> } };
};

// 最後に動いた時刻。ISO 文字列は辞書順で比べられる。scalar の max() は NULL が混ざると NULL になるので '' に寄せる
const LAST_MOVED = `max(
  coalesce(p.started_at, ''),
  coalesce(p.state_updated_at, ''),
  coalesce((SELECT max(coalesce(s.done_at, s.created_at)) FROM task_steps s WHERE s.task_id = p.id), '')
)`;

function startedLabel(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  } catch {
    return iso.slice(5, 16).replace("T", " ");
  }
}

/**
 * 止まったタスクを切り替える。wsId を渡すとそのワークスペースだけ (画面から開いたとき)、省くと全部 (cron)。
 * 返り値は切り替えた件数。
 */
export async function sweepStalled(db: DB, now: Date, wsId?: string): Promise<number> {
  const cutoff = new Date(now.getTime() - STALL_HOURS * 3600_000).toISOString();
  const { results } = await db.prepare(
    `SELECT p.id, p.workspace_id AS ws, p.started_at, p.started_by_name, p.started_via, coalesce(w.timezone, 'Asia/Tokyo') AS tz,
            (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = p.id) AS steps,
            (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = p.id AND s.done_at IS NOT NULL) AS steps_done,
            (SELECT s.text FROM task_steps s WHERE s.task_id = p.id AND s.done_at IS NULL ORDER BY s.order_idx LIMIT 1) AS next_step
       FROM projects p LEFT JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.started_at IS NOT NULL AND p.status = 'active' ${wsId ? "AND p.workspace_id = ?2" : ""}
        AND ${LAST_MOVED} < ?1
      ORDER BY p.started_at`
  ).bind(...(wsId ? [cutoff, wsId] : [cutoff])).all<{
    id: string; ws: string; started_at: string; started_by_name: string | null; started_via: string | null; tz: string;
    steps: number; steps_done: number; next_step: string | null;
  }>();
  const rows = results ?? [];
  const at = now.toISOString();
  for (const r of rows) {
    const who = (r.started_by_name || "").trim() || "不明";
    const via = (r.started_via || "").trim();
    const parts = [`${who}${via && via !== "app" ? ` (${via})` : ""} が ${startedLabel(r.started_at, r.tz)} に開始し、${STALL_HOURS}時間以上動きがなかった`];
    if (r.steps > 0) parts.push(`手順は ${r.steps_done}/${r.steps} 済み${r.next_step ? `、次は「${r.next_step}」` : ""}`);
    await db.prepare(
      `UPDATE projects SET started_at = NULL, started_by = NULL, started_by_name = NULL, started_via = NULL,
              stalled_at = ?, stalled_note = ?
        WHERE id = ? AND workspace_id = ? AND started_at = ?`
    ).bind(at, parts.join("。"), r.id, r.ws, r.started_at).run();
  }
  return rows.length;
}

/** 動いたら止まった印を消す。開始・完了・現状の更新・手順の操作のときに呼ぶ SQL 断片 (SET 句に足す) */
export const CLEAR_STALL_SET = "stalled_at = NULL, stalled_note = NULL";
