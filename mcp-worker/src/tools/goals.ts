// MCP ツール (goals)。index.ts の tools から切り出し。
import { z } from "zod";
import { findPrecedents, PRECEDENTS_NOTE, privacyProblem, upsertPlaybook, shouldRecordPlaybook, recordPlaybookAction } from "../playbooks";
import { kataForGoal, kataNote, templateIdForGoal } from "../kata";
import { exportTemplate, kataExportConfig, kataExportTarget } from "../../../app/lib/server/templateCore";
import { COMPLETION_CRITERIA_DOC, CURRENT_STATE_DOC } from "../instructions";
import { GOAL_LIST_COLUMNS, SUBTREE_CTE, ToolDef, assertCanEdit, assertGoalInScope, assignCreatorAsHolder, clearStartedOnParent, formatFieldText, goalInScope, inheritAssigneeFromAncestors, nowIso, parentStateNote, recordRecipients, resolveCreator, taskProgress, uid } from "../lib";

export const goalsTools: Record<string, ToolDef> = {
  list_goals: {
    description:
      "List non-archived goals (projects), ordered by order_idx. Paginated — default 100, max 500 rows; pass offset to page further.",
    schema: z.object({
      limit: z.number().int().min(1).max(500).optional().describe("Max rows, default 100"),
      offset: z.number().int().min(0).optional().describe("Rows to skip, default 0"),
    }),
    handler: async (args, env, wsId, auth) => {
      const limit = args.limit ?? 100;
      const offset = args.offset ?? 0;
      if (auth.scopeRoots) {
        const { results } = await env.DB.prepare(
          `${SUBTREE_CTE}
           SELECT ${GOAL_LIST_COLUMNS} FROM projects WHERE id IN (SELECT id FROM sub) AND status != 'archived' AND workspace_id = ? ORDER BY order_idx LIMIT ? OFFSET ?`
        ).bind(wsId, JSON.stringify(auth.scopeRoots), wsId, limit, offset).all();
        return results;
      }
      const { results } = await env.DB.prepare(
        `SELECT ${GOAL_LIST_COLUMNS} FROM projects WHERE status != 'archived' AND workspace_id = ? ORDER BY order_idx LIMIT ? OFFSET ?`
      ).bind(wsId, limit, offset).all();
      return results;
    },
  },

  get_goal: {
    description:
      "Get a single goal (project) by id. task_progress summarizes its direct tasks as of now " +
      "(done/total, recent completions, next open tasks, overdue) and says whether current_state " +
      "is older than the latest task movement — if so, rewrite current_state with update_goal. " +
      "kata が付いていたら、それがこの仕事の型 (資料・注意点・以前のやり方)。手を動かす前に読む。",
    schema: z.object({ id: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first();
      if (!row) throw new Error(`goal not found: ${args.id}`);
      const p = await taskProgress(env, wsId, args.id);
      const g = row as { name?: string | null; completion_criteria?: string | null };
      const precedents = await findPrecedents(env.DB, wsId, `${g.name ?? ""}\n${g.completion_criteria ?? ""}`, {
        ai: env.AI,
        excludeSourceIds: [args.id],
        canSee: (id) => goalInScope(env, auth, id),
      });
      const kata = await kataForGoal(env.DB, wsId, { id: args.id, ...g }, env.AI, kataExportTarget(env as unknown as Record<string, unknown>));
      return {
        ...(row as object),
        task_progress: p.text,
        current_state_is_stale: p.stale,
        ...(kata ? { kata, kata_note: kataNote(kata, "get") } : {}),
        ...(precedents.length ? { precedents, precedents_note: PRECEDENTS_NOTE } : {}),
      };
    },
  },

  create_goal: {
    description:
      "Create a new goal (project). Appended to the end among its siblings. " +
      "Optionally nest under parentId (a scoped session creates under its scope goal by default).",
    schema: z.object({
      name: z.string().min(1).describe(
        "Goal name。達成したい状態や対象を名前にする。[AI] / [人] などの担当プレフィックスは付けない (担当はアサインで表す)"
      ),
      parentId: z.string().optional().describe("Parent goal id; omitted = top level (or the scope goal for scoped sessions)"),
      completion_criteria: z.string().optional().describe(COMPLETION_CRITERIA_DOC),
      current_state: z.string().optional().describe(CURRENT_STATE_DOC),
    }),
    handler: async (args, env, wsId, auth) => {
      // a scoped session may only create inside its subtrees — default to the
      // scope root when there is exactly one, otherwise the caller must pick
      const parentId: string | null =
        args.parentId ?? (auth.scopeRoots && auth.scopeRoots.length === 1 ? auth.scopeRoots[0] : null);
      if (auth.scopeRoots && !parentId) {
        throw new Error("parentId is required: 複数のゴールにアサインされているため、どのゴール配下に作成するか parentId で指定してください");
      }
      if (parentId) {
        await assertGoalInScope(env, auth, parentId);
        await assertCanEdit(env, wsId, auth, parentId);
        const parent = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(parentId, wsId).first();
        if (!parent) throw new Error(`parent goal not found: ${parentId}`);
      }
      const id = uid();
      const created = nowIso();
      const max = await env.DB.prepare(
        "SELECT COALESCE(MAX(order_idx), -1) AS m FROM projects WHERE workspace_id = ? AND parent_goal_id IS ?"
      ).bind(wsId, parentId).first<{ m: number }>();
      const orderIdx = (max?.m ?? -1) + 1;
      // 完了の基準と現状は作成時に一緒に書けるようにしてある。後から update_goal で
      // 足す作りだと、その1回が飛ばされて基準が空のままのゴールが積み上がる。
      await env.DB.prepare(
        "INSERT INTO projects (id, name, parent_goal_id, order_idx, created_at, status, workspace_id, completion_criteria, current_state, criteria_updated_at, state_updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)"
      )
        .bind(
          id,
          args.name.trim(),
          parentId,
          orderIdx,
          created,
          wsId,
          args.completion_criteria === undefined ? null : formatFieldText(args.completion_criteria),
          args.current_state === undefined ? null : formatFieldText(args.current_state),
          args.completion_criteria === undefined ? null : created,
          args.current_state === undefined ? null : created
        )
        .run();
      await clearStartedOnParent(env, wsId, parentId);
      const assignee =
        (await assignCreatorAsHolder(env, wsId, id, auth.actor)) ??
        (await inheritAssigneeFromAncestors(env, wsId, id, parentId));
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
      return { ...(row as object), assigned_member_id: assignee };
    },
  },

  update_goal: {
    description:
      "Update fields on a goal (project). Only the provided fields are changed. " +
      "Supports name, current_state, completion_criteria, deadline, status.",
    schema: z.object({
      id: z.string().min(1),
      name: z.string().optional().describe(
        "目標名。[AI] / [人+AI] / [人] のプレフィックスは付けない (担当はアサインで表す)。既に付いているものを見つけたらここで外す"
      ),
      current_state: z.string().optional().describe(
        CURRENT_STATE_DOC
      ),
      completion_criteria: z.string().optional().describe(
        COMPLETION_CRITERIA_DOC
      ),
      deadline: z.string().optional().describe("ISO date/datetime string"),
      status: z.string().optional().describe("e.g. active / archived"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      await assertCanEdit(env, wsId, auth, args.id);
      if (args.current_state !== undefined) args.current_state = formatFieldText(args.current_state);
      if (args.completion_criteria !== undefined) args.completion_criteria = formatFieldText(args.completion_criteria);
      const fields: string[] = [];
      const binds: unknown[] = [];
      for (const key of ["name", "current_state", "completion_criteria", "deadline", "status"] as const) {
        if (args[key] !== undefined) {
          fields.push(`${key} = ?`);
          binds.push(args[key]);
        }
      }
      // 中身が実際に変わったときだけ更新日時を付ける (SET の右辺は更新前の値を見る)。
      // タスクが動いた後に現状が書き換えられたかどうかの判定に使う。
      if (args.current_state !== undefined) {
        fields.push("state_updated_at = CASE WHEN current_state IS NOT ? THEN ? ELSE state_updated_at END");
        binds.push(args.current_state, nowIso());
      }
      if (args.completion_criteria !== undefined) {
        fields.push("criteria_updated_at = CASE WHEN completion_criteria IS NOT ? THEN ? ELSE criteria_updated_at END");
        binds.push(args.completion_criteria, nowIso());
      }
      // archiving convenience: stamp archived_at when status flips to archived
      if (args.status === "archived") {
        fields.push("archived_at = ?");
        binds.push(nowIso());
      }
      if (fields.length === 0) throw new Error("no fields to update");
      binds.push(args.id, wsId);
      const res = await env.DB.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ? AND workspace_id = ?`)
        .bind(...binds)
        .run();
      if (!res.meta.changes) throw new Error(`goal not found: ${args.id}`);
      // アーカイブは配下ごと落とす。自分だけ落とすと、残った子が親を失って
      // 最上位に浮き上がり、文脈のないタスクがトップに並ぶ。
      if (args.status === "archived") {
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM projects WHERE parent_goal_id = ? AND workspace_id = ?
             UNION
             SELECT c.id FROM sub CROSS JOIN projects c ON c.parent_goal_id = sub.id WHERE c.workspace_id = ?
           )
           UPDATE projects SET status='archived', archived_at=?
            WHERE workspace_id = ? AND status != 'archived' AND id IN (SELECT id FROM sub)`
        ).bind(args.id, wsId, wsId, nowIso(), wsId).run();
      }
      return env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first();
    },
  },

  move_goal: {
    description:
      "Re-parent and/or reorder a goal in the tree. parentId = new parent goal " +
      "(null/omitted = move to the top level). beforeId = insert immediately " +
      "before that sibling (omitted/null = append to the end). Cannot move a goal " +
      "under itself or one of its own descendants (rejected). Siblings under the " +
      "destination are reindexed to a contiguous 0..n.",
    schema: z.object({
      id: z.string().min(1).describe("Goal (project) id to move"),
      parentId: z.string().nullable().optional().describe("New parent goal id; null or omitted = top level (root)"),
      beforeId: z.string().nullable().optional().describe("Sibling id to insert before; omitted/null = append to the end"),
    }),
    handler: async (args, env, wsId, auth) => {
      const id: string = args.id;
      const newParentId: string | null = args.parentId ?? null;
      const beforeId: string | null = args.beforeId ?? null;
      if (newParentId === id) throw new Error("cannot move a goal under itself");
      await assertGoalInScope(env, auth, id);
      await assertCanEdit(env, wsId, auth, id);
      // a scoped session can never move a goal to the top level (that would
      // lift it out of the subtree); the destination must be in scope too
      if (auth.scopeRoots && !newParentId) throw new Error("scoped session: parentId is required (must stay inside your assigned goals)");
      if (newParentId) await assertGoalInScope(env, auth, newParentId);
      if (newParentId) await assertCanEdit(env, wsId, auth, newParentId);
      const self = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
      if (!self) throw new Error(`goal not found: ${id}`);
      if (newParentId) {
        const dest = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(newParentId, wsId).first();
        if (!dest) throw new Error(`parent goal not found: ${newParentId}`);
        await clearStartedOnParent(env, wsId, newParentId);
        // cycle guard: walk up from the destination; hitting `id` means the
        // destination is a descendant of the moved node -> reject.
        let cur: string | null = newParentId;
        let guard = 0;
        while (cur && guard++ < 1000) {
          if (cur === id) throw new Error("cannot move a goal under its own descendant");
          const r: { parent_goal_id: string | null } | null = await env.DB
            .prepare("SELECT parent_goal_id FROM projects WHERE id = ? AND workspace_id = ?")
            .bind(cur, wsId).first();
          cur = r?.parent_goal_id ?? null;
        }
      }
      // existing siblings under the destination (excluding the moved node), in order
      const sibsRes = newParentId
        ? await env.DB.prepare("SELECT id FROM projects WHERE parent_goal_id = ? AND status != 'archived' AND workspace_id = ? AND id <> ? ORDER BY order_idx ASC, created_at ASC").bind(newParentId, wsId, id).all()
        : await env.DB.prepare("SELECT id FROM projects WHERE parent_goal_id IS NULL AND status != 'archived' AND workspace_id = ? AND id <> ? ORDER BY order_idx ASC, created_at ASC").bind(wsId, id).all();
      const order = (sibsRes.results as { id: string }[]).map((s) => s.id);
      let insertAt = order.length;
      if (beforeId) {
        const idx = order.indexOf(beforeId);
        if (idx >= 0) insertAt = idx;
      }
      order.splice(insertAt, 0, id);
      await env.DB.prepare("UPDATE projects SET parent_goal_id = ? WHERE id = ? AND workspace_id = ?").bind(newParentId, id, wsId).run();
      if (order.length) {
        await env.DB.batch(order.map((sid, i) =>
          env.DB.prepare("UPDATE projects SET order_idx = ? WHERE id = ? AND workspace_id = ?").bind(i, sid, wsId)
        ));
      }
      return env.DB.prepare("SELECT id, name, parent_goal_id, order_idx FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
    },
  },

  // ---- subtasks (nodes) ----
  // NOTE: subtasks are child goals (the same `projects` rows the app's own
  // "タスク" list under a goal renders), NOT the separate `nodes` table. These
  // tools used to write to `nodes`, which nothing in the current app UI reads
  // (only an unused, unmounted Outliner component does) — every subtask
  // created that way was invisible in the app. Fixed to match what the UI
  // actually shows.
  list_subtasks: {
    description: "List subtasks (child goals) under a goal, ordered by order_idx.",
    schema: z.object({ goalId: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const { results } = await env.DB.prepare(
        `SELECT ${GOAL_LIST_COLUMNS} FROM projects WHERE parent_goal_id = ? AND status != 'archived' AND workspace_id = ? ORDER BY order_idx`
      )
        .bind(args.goalId, wsId)
        .all();
      return results;
    },
  },

  add_subtask: {
    description:
      "Add a subtask to a goal — creates it as a child goal, exactly like the app's " +
      "own 'タスク' list under this goal (and create_goal with parentId). order_idx " +
      "becomes max+1 among siblings. Call again with the new subtask's id as goalId " +
      "to nest another level. 担当者は自動で決まる: 作ったあなた本人 (返り値 assigned_member_id)。" +
      "別の人に持たせたいときだけ assign_member_to_goal。",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id to add the subtask under"),
      text: z.string().min(1).describe(
        "Subtask text。1タスク=1アクションで登録する (複数アクションを1個に詰めない)。[AI] / [人+AI] / [人] のプレフィックスは付けない (担当はアサインで表す)"
      ),
      completion_criteria: z.string().optional().describe(
        "この小タスクの完了の基準。1〜2行で「何ができたら終わりか」を、他人が○×を付けられる形で書く (成果物名・数値・確認方法のどれかを入れる)。例: 「原稿3本を 20_法務/ に置き、本番ビルドで 404 になることを確認」"
      ),
      current_state: z.string().optional().describe("作る時点で分かっている前提があれば1〜2行。無ければ省く"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      await assertCanEdit(env, wsId, auth, args.goalId);
      const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      const id = uid();
      const created = nowIso();
      const max = await env.DB.prepare(
        "SELECT COALESCE(MAX(order_idx), -1) AS m FROM projects WHERE workspace_id = ? AND parent_goal_id = ?"
      ).bind(wsId, args.goalId).first<{ m: number }>();
      const orderIdx = (max?.m ?? -1) + 1;
      // 小タスクにも完了の基準・現状を持たせる (親だけに書くと、小タスクを開いた人や AI が「何ができたら終わりか」を読めない)
      const criteria = args.completion_criteria?.trim() || null;
      const state = args.current_state?.trim() || null;
      await env.DB.prepare(
        `INSERT INTO projects (id, name, parent_goal_id, order_idx, created_at, status, workspace_id,
                               completion_criteria, current_state, criteria_updated_at, state_updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
        .bind(id, args.text.trim(), args.goalId, orderIdx, created, wsId,
          criteria, state, criteria ? created : null, state ? created : null)
        .run();
      await clearStartedOnParent(env, wsId, args.goalId);
      const assignee =
        (await assignCreatorAsHolder(env, wsId, id, auth.actor)) ??
        (await inheritAssigneeFromAncestors(env, wsId, id, args.goalId));
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
      // 親の名前は混ぜない。混ぜると親に似た型が、関係ないタスクにも毎回付く。
      const precedents = await findPrecedents(env.DB, wsId, args.text, {
        ai: env.AI,
        excludeSourceIds: [id, args.goalId],
        canSee: (gid) => goalInScope(env, auth, gid),
      });
      return {
        ...(row as object),
        assigned_member_id: assignee,
        ...(await parentStateNote(env, wsId, args.goalId)),
        ...(precedents.length ? { precedents, precedents_note: PRECEDENTS_NOTE } : {}),
      };
    },
  },

  start_task: {
    description:
      "タスクを「進行中」にする。作業に入る前 (手を動かし始める前) に必ず呼ぶ。人は画面の進行中の印で、今どのタスクを誰のAIが進めているかを見ている。" +
      "付けられるのは一番下の小タスク (未完了の子を持たないもの) だけ。ToDo と同じで、実際に手を動かす一番下を開始する。子を持つタスクを指定しても何もせず、その旨を返す。" +
      "開始した人 (接続している本人) と日時と使っているAIの名前が残る。既に進行中なら最初に始めた記録を残したまま何もしない。完了済みのタスクには付かない。" +
      "終わったら complete_subtask。started=false は押し間違いの取り消し用。",
    schema: z.object({
      id: z.string().min(1).describe("Task (goal) id"),
      agent: z.string().max(40).optional().describe("使っているAIの名前 (例: Claude Code / Codex / claude.ai)。画面に「黒崎 (Claude Code)」のように出る。省略時は AI"),
      started: z.boolean().optional().describe("false で進行中を取り消す (既定 true)"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      await assertCanEdit(env, wsId, auth, args.id);
      if (args.started === false) {
        const res = await env.DB.prepare(
          "UPDATE projects SET started_at = NULL, started_by = NULL, started_by_name = NULL, started_via = NULL WHERE id = ? AND workspace_id = ?"
        ).bind(args.id, wsId).run();
        if (!res.meta.changes) throw new Error(`task not found: ${args.id}`);
      } else {
        const who = await resolveCreator(env, wsId, auth.actor);
        const via = (args.agent ?? "").trim() || "AI";
        await env.DB.prepare(
          `UPDATE projects SET started_at = ?, started_by = ?, started_by_name = ?, started_via = ?
            WHERE id = ? AND workspace_id = ? AND status = 'active' AND started_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM projects c WHERE c.parent_goal_id = projects.id AND c.workspace_id = projects.workspace_id AND c.status = 'active')`
        ).bind(nowIso(), who?.userId ?? null, who?.name ?? null, via, args.id, wsId).run();
      }
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first<{ status: string; started_at: string | null; name: string | null; completion_criteria: string | null }>();
      if (!row) throw new Error(`task not found: ${args.id}`);
      const hasKids = await env.DB.prepare("SELECT 1 AS x FROM projects WHERE parent_goal_id = ? AND workspace_id = ? AND status = 'active' LIMIT 1").bind(args.id, wsId).first();
      const note =
        args.started === false ? "進行中を取り消した。"
        : row.status !== "active" ? "完了済み (またはアーカイブ済み) のタスクなので進行中にしていない。開き直すなら complete_subtask で completed=false。"
        : hasKids ? "子を持つタスクなので進行中にしていない。進行中は一番下の小タスクにだけ付ける。今から手を付ける小タスク (list_subtasks で見る) に start_task する。"
        : "進行中。終わったら complete_subtask で完了にする。";
      // 始めるときに型を読ませる (取り消し・完了済みでは出さない)
      const kata = args.started !== false && row.status === "active" ? await kataForGoal(env.DB, wsId, { id: args.id, ...row }, env.AI, kataExportTarget(env as unknown as Record<string, unknown>)) : null;
      return { ...(row as object), note, ...(kata ? { kata, kata_note: kataNote(kata, "start") } : {}) };
    },
  },

  complete_subtask: {
    description:
      "Mark a subtask (child goal) complete or incomplete. Sets status to 'done' or 'active'. " +
      "完了にするときは current_state に結果 (何をして、何が確認できたか・未確認は何か) を1〜3行で渡すと、その小タスクの現状に残る。",
    schema: z.object({
      id: z.string().min(1).describe("Subtask (goal) id"),
      completed: z.boolean().describe("true = complete, false = reopen"),
      current_state: z.string().optional().describe("この小タスクの結果。何をして・何が確認できたか・未確認は何か (コミットや成果物の場所があれば添える)"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      await assertCanEdit(env, wsId, auth, args.id);
      const status = args.completed ? "done" : "active";
      // completed_at を残す。projects には status='done' しか無かったため
      // 「いつ終わったか」が一切残らず、速度も「提案は実行されたか」も測れなかった
      // (done_log は nodes 側の完了しか書かない)。
      // completed_by は「終えたタスク」の数え上げ用 (0025)。AI が閉じたらトークンの持ち主の完了として数える
      const res = await env.DB.prepare(
        "UPDATE projects SET status = ?, completed_at = ?, completed_by = ? WHERE id = ? AND workspace_id = ?"
      )
        .bind(status, args.completed ? nowIso() : null, args.completed ? (auth.actor?.email?.toLowerCase().trim() || null) : null, args.id, wsId)
        .run();
      if (!res.meta.changes) throw new Error(`subtask not found: ${args.id}`);
      if (args.current_state?.trim()) {
        await env.DB.prepare("UPDATE projects SET current_state = ?, state_updated_at = ? WHERE id = ? AND workspace_id = ?")
          .bind(args.current_state.trim(), nowIso(), args.id, wsId).run();
      }
      if (args.completed) {
        // 親を完了したら配下も完了にする (queries.ts の cascadeGoalDone と同じ挙動)。
        // 伝播させないと閉じた親の下に未完のものが残り、一覧・検索・「今日」に出続ける。
        // ゴールだけでなく、ゴールがぶら下げている小タスク (nodes) も閉じること。
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM projects WHERE id = ?1 AND workspace_id = ?2
             UNION ALL
             SELECT p.id FROM sub CROSS JOIN projects p ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?2
           )
           UPDATE projects SET status = 'done', completed_at = ?3
            WHERE workspace_id = ?2 AND status = 'active' AND id IN (SELECT id FROM sub)`
        )
          .bind(args.id, wsId, nowIso())
          .run();
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM projects WHERE id = ?1 AND workspace_id = ?2
             UNION ALL
             SELECT p.id FROM sub CROSS JOIN projects p ON p.parent_goal_id = sub.id WHERE p.workspace_id = ?2
           )
           UPDATE nodes SET completed_at = ?3, updated_at = ?3
            WHERE workspace_id = ?2 AND completed_at IS NULL AND project_id IN (SELECT id FROM sub)`
        )
          .bind(args.id, wsId, nowIso())
          .run();
        // mirrors the app's own toggleProjectDone (queries.ts) — without this
        // the phone push callback fires with nothing new to show.
        const goal = await env.DB.prepare("SELECT name FROM projects WHERE id = ?").bind(args.id).first<{ name: string | null }>();
        if (goal?.name?.trim()) {
          const notifId = uid();
          await env.DB.prepare(
            "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, 'goal', ?, ?, ?, ?, ?)"
          )
            .bind(notifId, "完了", `「${goal.name.trim()}」を完了しました`, args.id, nowIso(), wsId)
            .run();
          await recordRecipients(env, notifId, wsId, args.id);
        }
      }
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first<{ parent_goal_id: string | null; name: string | null; completion_criteria: string | null }>();
      const note: { parent_task_progress?: string; next_action?: string; kata?: object; kata_note?: string } =
        row?.parent_goal_id ? await parentStateNote(env, wsId, row.parent_goal_id, args.completed) : {};
      // 中身のあるタスクを閉じたら、そのやり方を型に残させる。次に同じ種類の仕事をする人の AI に渡る。
      if (args.completed && (await shouldRecordPlaybook(env.DB, wsId, args.id))) {
        const a = recordPlaybookAction(args.id);
        note.next_action = note.next_action ? `${note.next_action}\nもう1つ: ${a}` : a;
      }
      // 終えるときは型の注意点で照合させる (サーバー側で渡すので、どのメンバーの AI にも効く)
      if (args.completed && row) {
        const kata = await kataForGoal(env.DB, wsId, { id: args.id, ...row }, env.AI, kataExportTarget(env as unknown as Record<string, unknown>));
        if (kata && (kata.how === "from_template" || kata.cautions.length)) { note.kata = kata; note.kata_note = kataNote(kata, "complete"); }
      }
      return { ...(row as object), ...note };
    },
  },

  record_playbook: {
    description:
      "終えたタスクのやり方を「前例」として残す。前例は全メンバーの AI に共有され、似たタスクの get_goal / add_subtask の返り値 (precedents) に自動で付く。" +
      "complete_subtask の next_action で求められたら呼ぶ。同じタスクで呼び直すと上書き。" +
      "全員に見えるので、顧客名・個人名・金額・連絡先・キーは書かず「顧客」「先方」と一般化する (メール・電話・金額らしき文字列は弾く)。",
    schema: z.object({
      source_goal_id: z.string().min(1).describe("型の元になった (終えた) タスクの id"),
      title: z.string().min(4).max(120).describe("何をするときの型か。一般化した1行。例: 顧客向けLPを公開して問い合わせフォームまで確認する"),
      keywords: z.array(z.string().min(1).max(40)).max(10).optional().describe("探すときの語 3〜8個 (一般名詞・ツール名)"),
      steps: z.string().min(10).describe("実際にやった順の手順。「1. 」から1行1手順、3〜8個。ツール名・コマンド・画面名は具体的に残す"),
      pitfalls: z.string().optional().describe("つまずいたこと・気をつけたこと。無ければ省く"),
      commits: z
        .array(z.object({ repo: z.string().min(1), sha: z.string().min(7), message: z.string().optional() }))
        .max(20)
        .optional()
        .describe("このタスクで入れたコミット。コミットメッセージに Task: <タスクid> を入れておき、git log --all --grep <タスクid> で拾う"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.source_goal_id);
      await assertCanEdit(env, wsId, auth, args.source_goal_id);
      const src = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(args.source_goal_id, wsId).first();
      if (!src) throw new Error(`goal not found: ${args.source_goal_id}`);
      const body = [args.title, ...(args.keywords ?? []), args.steps, args.pitfalls ?? ""].join("\n");
      const bad = privacyProblem(body);
      if (bad) throw new Error(`前例は全メンバーに見えるため、${bad}らしき文字列は入れられません。「顧客」「先方」「費用」などに一般化して書き直してください`);
      const r = await upsertPlaybook(env.DB, wsId, {
        id: uid(),
        sourceGoalId: args.source_goal_id,
        authorName: auth.actor?.name ?? null,
        authorEmail: auth.actor?.email ?? null,
        title: args.title.trim(),
        keywords: args.keywords ?? [],
        steps: formatFieldText(args.steps),
        pitfalls: args.pitfalls?.trim() ? formatFieldText(args.pitfalls) : null,
        commits: args.commits ?? [],
        now: nowIso(),
      });
      // 型から作ったタスクの前例は、その型の「やり方」として結ぶ (黒崎判断 2026-10-15)
      const tplId = await templateIdForGoal(env.DB, wsId, args.source_goal_id);
      if (tplId) {
        await env.DB.prepare("UPDATE playbooks SET template_id = ? WHERE id = ? AND workspace_id = ? AND template_id IS NULL").bind(tplId, r.id, wsId).run();
        // 型の中身 (前例) が増えたので外の Markdown も書き直す。失敗しても前例の保存は済んでいる
        const ex = await exportTemplate(env.DB, wsId, tplId, kataExportConfig(env as unknown as Record<string, unknown>), nowIso());
        if (ex.error) console.log(`[record_playbook] 型の書き出しに失敗: ${ex.error}`);
      }
      return { playbook_id: r.id, created: r.created, ...(tplId ? { template_id: tplId } : {}) };
    },
  },

};
