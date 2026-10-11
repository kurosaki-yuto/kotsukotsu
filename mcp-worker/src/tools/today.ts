// MCP ツール (today)。index.ts の tools から切り出し。
import { z } from "zod";
import { ballRank, ballText, personKeys } from "../../../app/lib/ball";
import { workspaceToday } from "../today";
import { SUBTREE_CTE, ToolDef, assertCanEdit, assertGoalInScope, assertNodeInScope, nowIso, resolveWho } from "../lib";

export const todayTools: Record<string, ToolDef> = {
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

  // 「自分の、今手を動かすタスク」の一覧。list_goals は会社全体・完了込みで担当も出ないので、
  // 予定を組む (app/lib/planDay.ts) ときに AI が自分のタスクを選べなかった (2026-10-05 実データで確認)。
  // 担当 (goal_members) が自分で、未完了で、未完了の子を持たない一番下のタスクだけを、優先の順で返す。
  list_my_tasks: {
    description:
      "自分が担当している未完了のタスク (未完了の子を持たない一番下のもの) を、優先の順で返す。" +
      "順番: 今日に入れたもの → 期限切れ・今日まで → 進行中 → 期限が3日以内 → その他。各行の why がどれに当たるか。" +
      "今日の予定を組む・今日やることを選ぶときは list_goals ではなくこれを使う。completion_criteria / current_state は先頭300字。" +
      "他のメンバーの分は member に名前 (姓だけ・スペース抜きでも可) かメールを渡す。メンバーごとに1回ずつ呼ぶ。" +
      "見える範囲は今までどおり (担当範囲が決まっている人は、その範囲のタスクだけ)。",
    schema: z.object({
      member: z.string().optional().describe("誰のタスクか。名前 (例: 田中 / 田中大二朗) かメール。省略時は接続している本人"),
      email: z.string().optional().describe("旧引数。member と同じ扱い"),
      limit: z.number().int().min(1).max(100).optional().describe("既定 30"),
      offset: z.number().int().min(0).optional().describe("既定 0"),
    }),
    handler: async (args, env, wsId, auth) => {
      // 誰のタスクか: member (名前かメール) → 接続している本人。名前はコメントの @メンションと同じ照合
      const { email, name: memberName } = await resolveWho(env, wsId, auth, (args.member || args.email || "").trim());
      const { date: today } = await workspaceToday(env.DB, wsId);
      const soon = new Date(`${today}T00:00:00Z`);
      soon.setUTCDate(soon.getUTCDate() + 3);
      const soonDate = soon.toISOString().slice(0, 10);
      const limit = args.limit ?? 30;
      const offset = args.offset ?? 0;
      const scoped = !!auth.scopeRoots;
      // 番号付きの引数で書く。?7 は担当範囲 (scopeRoots) の JSON。範囲が無いときは使わない
      const cte = `WITH RECURSIVE sub(id) AS (
          SELECT id FROM projects WHERE workspace_id = ?3 AND id IN (SELECT value FROM json_each(?7))
          UNION ALL
          SELECT p.id FROM sub s CROSS JOIN projects p ON p.parent_goal_id = s.id)`;
      const sql = `${scoped ? cte : ""}
        SELECT p.id, p.name, p.deadline, p.today_date, p.started_at, p.started_via,
               p.parent_goal_id, par.name AS parent_name,
               substr(p.completion_criteria, 1, 300) AS completion_criteria,
               substr(p.current_state, 1, 300) AS current_state,
               CASE WHEN p.today_date = ?1 THEN 'today'
                    WHEN p.deadline IS NOT NULL AND substr(p.deadline, 1, 10) <= ?1 THEN 'overdue_or_due_today'
                    WHEN p.started_at IS NOT NULL THEN 'in_progress'
                    WHEN p.deadline IS NOT NULL AND substr(p.deadline, 1, 10) <= ?2 THEN 'due_soon'
                    ELSE 'other' END AS why
          FROM projects p
          LEFT JOIN projects par ON par.id = p.parent_goal_id
         WHERE p.workspace_id = ?3
           AND p.status NOT IN ('done', 'archived') AND p.archived_at IS NULL
           AND EXISTS (SELECT 1 FROM goal_members gm JOIN members m ON m.id = gm.member_id
                        WHERE gm.goal_id = p.id AND m.workspace_id = ?3 AND lower(m.email) = lower(?4))
           AND NOT EXISTS (SELECT 1 FROM projects c
                            WHERE c.parent_goal_id = p.id AND c.workspace_id = ?3
                              AND c.status NOT IN ('done', 'archived') AND c.archived_at IS NULL)
           ${scoped ? "AND p.id IN (SELECT id FROM sub)" : ""}
         ORDER BY CASE why WHEN 'today' THEN 0 WHEN 'overdue_or_due_today' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'due_soon' THEN 3 ELSE 4 END,
                  p.deadline IS NULL, p.deadline, p.order_idx
         LIMIT ?5 OFFSET ?6`;
      const binds: unknown[] = [today, soonDate, wsId, email, limit + 1, offset];
      if (scoped) binds.push(JSON.stringify(auth.scopeRoots));
      const stmt = env.DB.prepare(sql).bind(...binds);
      const rows = (await stmt.all()).results ?? [];
      return { today, member: memberName, email, items: rows.slice(0, limit), hasMore: rows.length > limit, offset };
    },
  },

  // 「あなたの番」: 現状の「ボール:」の行に名前があるタスク (app/lib/ball.ts。アプリのタスク画面と同じ判定)
  list_my_turn: {
    description:
      "自分 (または member で指定したメンバー) の番になっている未完了タスクを返す。各タスクの現状の「ボール:」の行に、その人の名前 (フルネームか姓) が書かれているもの。" +
      "direct=true は「ボール: 黒崎 (…)」のように持ち主として書かれたもの、false は「ボール: こちら (黒崎の判断待ち)」のように括弧の中に出るもの。" +
      "「私の番は」「返事待ちになっているのは」と聞かれたらこれを使う。期限があるもの → 持ち主として書かれたもの → 現状が新しい順。",
    schema: z.object({
      member: z.string().optional().describe("誰の番か。名前 (姓だけでも可) かメール。省略時は接続している本人"),
    }),
    handler: async (args, env, wsId, auth) => {
      const { email, name } = await resolveWho(env, wsId, auth, (args.member || "").trim());
      const keys = personKeys(name || "");
      if (!keys.length) throw new Error("名簿に表示名が無いので、ボールの行と照らせません");
      const scoped = !!auth.scopeRoots;
      const cte = `WITH RECURSIVE sub(id) AS (
          SELECT id FROM projects WHERE workspace_id = ?1 AND id IN (SELECT value FROM json_each(?2))
          UNION ALL
          SELECT p.id FROM sub s CROSS JOIN projects p ON p.parent_goal_id = s.id)`;
      const sql = `${scoped ? cte : ""}
        SELECT p.id, p.name, par.name AS parent_name, p.deadline, p.state_updated_at, p.current_state
          FROM projects p LEFT JOIN projects par ON par.id = p.parent_goal_id
         WHERE p.workspace_id = ?1 AND p.status NOT IN ('done', 'archived') AND p.archived_at IS NULL
           AND p.current_state LIKE '%ボール%'
           ${scoped ? "AND p.id IN (SELECT id FROM sub)" : ""}`;
      const stmt = scoped ? env.DB.prepare(sql).bind(wsId, JSON.stringify(auth.scopeRoots)) : env.DB.prepare(sql).bind(wsId);
      const rows = ((await stmt.all()).results ?? []) as { id: string; name: string; parent_name: string | null; deadline: string | null; state_updated_at: string | null; current_state: string }[];
      const items = rows.flatMap((r) => {
        const ball = ballText(r.current_state);
        const rank = ball ? ballRank(ball, keys) : 0;
        return rank ? [{ id: r.id, name: r.name, parent_name: r.parent_name, deadline: r.deadline, state_updated_at: r.state_updated_at, ball, direct: rank === 1 }] : [];
      });
      items.sort((a, b) => {
        if (!!a.deadline !== !!b.deadline) return a.deadline ? -1 : 1;
        if (a.deadline && b.deadline && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
        if (a.direct !== b.direct) return a.direct ? -1 : 1;
        return (b.state_updated_at ?? "").localeCompare(a.state_updated_at ?? "");
      });
      return { member: name, email, count: items.length, items };
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
        await assertCanEdit(env, wsId, auth, id);
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

};
