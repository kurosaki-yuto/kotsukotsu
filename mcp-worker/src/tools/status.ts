// MCP ツール (status)。「どうなってる」と聞かれたときに、人の判断が要るタスクをタスクの文脈つきで返す。
// 黒崎判断 2026-11-02: 盤には出さない (盤は 期限切れ・近い / 今日終えた だけ)。あなたの番・止まっている・
// 閉じていい？ は AI が会話で出す。タスク名だけでは何の話か分からないので、上のゴールの名前・現状・何が要るかを必ず付ける。
import { z } from "zod";
import { ballRank, ballText, personKeys } from "../../../app/lib/ball";
import type { Env } from "../env";
import { McpAuth, ToolDef, resolveWho } from "../lib";

type Row = {
  id: string; name: string; deadline: string | null; state_updated_at: string | null; current_state: string | null;
  stalled_at: string | null; stalled_note: string | null; parents: string | null; n?: number;
};
export type StatusItem = {
  id: string;
  name: string;
  /** 上のゴールの名前 (一番上 → 親の順) */
  path: string[];
  deadline: string | null;
  state_updated_at: string | null;
  /** タスクの現状 (全文)。何の話かはここで分かる */
  current_state: string | null;
  /** このタスクで何が要るか (AI が本人に言う一言) */
  ask: string;
};

// 現状に「終わった」と書いてあるのに開いたまま (queries/attention.ts と同じ言葉)
const DONE_WORDS = ["%照合%PASS%", "%作業は済み%", "%完了チェックはまだ%", "%完了の印を付けられていない%", "%完了の関門%"];
const COMPANY_WORDS = ["%株式会社%", "%合同会社%", "%有限会社%", "%（株）%", "%(株)%"];

// 見える範囲 (list_my_turn と同じ): 担当の配下だけ。ワークスペースキーと管理者は全部
function scope(auth: McpAuth, wsId: string): { cte: string; where: string; binds: unknown[] } {
  if (!auth.scopeRoots) return { cte: "", where: "", binds: [wsId] };
  return {
    cte: `WITH RECURSIVE sub(id) AS (
      SELECT id FROM projects WHERE workspace_id = ?1 AND id IN (SELECT value FROM json_each(?2))
      UNION
      SELECT p.id FROM sub s CROSS JOIN projects p ON p.parent_goal_id = s.id)`,
    where: "AND p.id IN (SELECT id FROM sub)",
    binds: [wsId, JSON.stringify(auth.scopeRoots)],
  };
}

// 上のゴールの名前を「一番上 / … / 親」でつなぐ (最大 6 段)。担当の範囲があるときは範囲の中 (sub) だけたどる
const parents = (scoped: boolean) => `(SELECT group_concat(name, ' / ') FROM (
  WITH RECURSIVE up(id, parent, name, depth) AS (
    SELECT p0.id, p0.parent_goal_id, p0.name, 0 FROM projects p0 WHERE p0.id = p.parent_goal_id${scoped ? " AND p0.id IN (SELECT id FROM sub)" : ""}
    UNION ALL
    SELECT q.id, q.parent_goal_id, q.name, up.depth + 1 FROM up JOIN projects q ON q.id = up.parent WHERE up.depth < 6${scoped ? " AND q.id IN (SELECT id FROM sub)" : ""})
  SELECT name FROM up ORDER BY depth DESC))`;
const cols = (scoped: boolean) =>
  `p.id, p.name, p.deadline, p.state_updated_at, p.current_state, p.stalled_at, p.stalled_note, ${parents(scoped)} AS parents`;

function item(r: Row, ask: string): StatusItem {
  return {
    id: r.id, name: r.name, path: (r.parents ?? "").split(" / ").filter(Boolean),
    deadline: r.deadline, state_updated_at: r.state_updated_at, current_state: r.current_state, ask,
  };
}
const days = (iso: string | null) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

async function run(env: Env, sql: string, binds: unknown[]): Promise<Row[]> {
  return ((await env.DB.prepare(sql).bind(...binds).all()).results ?? []) as Row[];
}

export async function statusReport(env: Env, wsId: string, auth: McpAuth, who: string) {
  const { email, name } = await resolveWho(env, wsId, auth, who);
  const keys = personKeys(name || "");
  const s = scope(auth, wsId);
  const COLS = cols(!!auth.scopeRoots);
  const base = `p.workspace_id = ?1 AND p.status = 'active' AND p.archived_at IS NULL ${s.where}`;
  const from = "FROM projects p";
  const openKids = `(SELECT COUNT(*) FROM projects c WHERE c.parent_goal_id = p.id AND c.workspace_id = p.workspace_id AND c.status = 'active')`;
  const kids = `(SELECT COUNT(*) FROM projects c WHERE c.parent_goal_id = p.id AND c.workspace_id = p.workspace_id AND c.status != 'archived')`;
  const steps = `(SELECT COUNT(*) FROM task_steps t WHERE t.task_id = p.id)`;
  const openSteps = `(SELECT COUNT(*) FROM task_steps t WHERE t.task_id = p.id AND t.done_at IS NULL)`;
  const today = new Date().toISOString().slice(0, 10);

  const [turnRows, stalledRows, overdueRows, stateDone, stepsDone, kidsDone] = await Promise.all([
    run(env, `${s.cte} SELECT ${COLS} ${from} WHERE ${base} AND p.current_state LIKE '%ボール%'`, s.binds),
    run(env, `${s.cte} SELECT ${COLS} ${from} WHERE ${base} AND p.stalled_at IS NOT NULL ORDER BY p.stalled_at DESC`, s.binds),
    run(env, `${s.cte} SELECT ${COLS} ${from} WHERE ${base} AND length(p.deadline) >= 10 AND substr(p.deadline, 1, 10) < ?${s.binds.length + 1} ORDER BY p.deadline`, [...s.binds, today]),
    run(env, `${s.cte} SELECT ${COLS} ${from} WHERE ${base} AND ${openKids} = 0 AND p.current_state NOT LIKE '%FAIL%' AND (${DONE_WORDS.map((_, i) => `p.current_state LIKE ?${s.binds.length + 1 + i}`).join(" OR ")})`, [...s.binds, ...DONE_WORDS]),
    run(env, `${s.cte} SELECT ${COLS}, ${steps} AS n ${from} WHERE ${base} AND ${steps} > 0 AND ${openSteps} = 0 AND ${openKids} = 0`, s.binds),
    run(env, `${s.cte} SELECT ${COLS}, ${kids} AS n ${from} WHERE ${base} AND p.parent_goal_id IS NOT NULL AND ${kids} > 0 AND ${openKids} = 0 AND ${COMPANY_WORDS.map((_, i) => `p.name NOT LIKE ?${s.binds.length + 1 + i}`).join(" AND ")}`, [...s.binds, ...COMPANY_WORDS]),
  ]);

  // あなたの番: 現状の「ボール:」に本人の名前があるもの
  const my_turn = keys.length
    ? turnRows.flatMap((r) => {
        const ball = ballText(r.current_state);
        const rank = ball ? ballRank(ball, keys) : 0;
        if (!rank) return [];
        const d = days(r.state_updated_at);
        return [item(r, `ボール: ${ball}${d !== null && d >= 3 ? ` (${d}日待たせている)` : ""}`)];
      })
    : [];
  my_turn.sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9") || (b.state_updated_at ?? "").localeCompare(a.state_updated_at ?? ""));

  const stalled = stalledRows.map((r) => item(r, `進行中のまま止まっている: ${r.stalled_note ?? ""}。続ける (start_task) か、終わっている (complete_subtask) か、やめる (archived) かを決める`));
  const overdue = overdueRows.map((r) => item(r, `期限 ${r.deadline?.slice(0, 10)} を ${Math.max(0, days(r.deadline) ?? 0)} 日過ぎている。期限を引き直すか、終わらせるか、やめるかを決める`));

  const seen = new Set<string>();
  const closable: StatusItem[] = [];
  const push = (r: Row, why: string) => { if (seen.has(r.id)) return; seen.add(r.id); closable.push(item(r, `${why}。閉じてよければ complete_subtask、まだなら現状に何が残っているかを書く`)); };
  for (const r of stateDone) push(r, "現状に「済んだ」と書いてあるのに開いたまま");
  for (const r of stepsDone) push(r, `作業の手順が全部済んでいる (${r.n}/${r.n})`);
  for (const r of kidsDone) push(r, `配下のタスクが全部終わっている (${r.n}件)`);
  closable.sort((a, b) => (a.state_updated_at ?? "").localeCompare(b.state_updated_at ?? ""));

  return {
    member: name, email,
    counts: { my_turn: my_turn.length, overdue: overdue.length, stalled: stalled.length, closable: closable.length },
    my_turn, overdue, stalled, closable,
    note:
      "本人に出すときは、件数だけでなくタスクごとに「何のタスクか (path と name)・今どうなっているか (current_state の要点)・何を決めてほしいか (ask)」を1〜3行で言う。" +
      "本人が答えたら、その場で complete_subtask / update_goal / start_task で反映する。本人に画面を見に行かせない",
  };
}

export const statusTools: Record<string, ToolDef> = {
  status_report: {
    description:
      "「どうなってる」「今どう」「止まってるのある？」「俺の番は？」と聞かれたら呼ぶ。人の判断が要るタスクを4つに分けて、タスクの文脈 (上のゴール・現状・何が要るか) つきで返す: " +
      "my_turn (現状の「ボール:」に本人の名前があるもの) / overdue (期限切れ) / stalled (進行中のまま24時間動かず止まっている) / closable (終わったと書いてある・手順や配下が全部済んだのに開いたまま)。" +
      "返り値をそのまま貼らず、タスクごとに「何のタスクか・今どうなっているか・何を決めてほしいか」を1〜3行で出し、本人の答えをその場でこつこつに反映する。",
    schema: z.object({
      member: z.string().optional().describe("誰の分か。名前 (姓だけでも可) かメール。省略時は接続している本人"),
    }),
    handler: async (args, env, wsId, auth) => statusReport(env, wsId, auth, (args.member || "").trim()),
  },
};
