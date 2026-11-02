// MCP ツール (goals)。index.ts の tools から切り出し。
import { z } from "zod";
import { findPrecedents, PRECEDENTS_NOTE, privacyProblem, upsertPlaybook, shouldRecordPlaybook, recordPlaybookAction } from "../playbooks";
import { kataForGoal, kataNote, templateIdForGoal } from "../kata";
import { exportTemplate, kataExportConfig, kataExportTarget } from "../../../app/lib/server/templateCore";
import { COMPLETION_CRITERIA_DOC, CURRENT_STATE_DOC } from "../instructions";
import { CLEAR_STALL_SET } from "../../../app/lib/stall";
import { inheritedResources, FILES_NOTE } from "../../../app/lib/server/resourcesCore";
import { criteriaProblem, stateProblem, resultProblem, matchCriteriaLine, numberedCriteria, requestConfirmation, CONFIRM_NOTE_PENDING, CONFIRM_NOTE_APPLIED } from "../../../app/lib/server/qualityCore";
import { GOAL_LIST_COLUMNS, SUBTREE_CTE, ToolDef, templateViewerOf, canEditGoal, assertCanEdit, assertGoalInScope, assignCreatorAsHolder, clearStartedOnParent, formatFieldText, goalInScope, inheritAssigneeFromAncestors, nowIso, parentStateNote, recordRecipients, resolveCreator, taskProgress, uid } from "../lib";

// 名前・現状・完了の基準の上限 (Web の編集 API の GOAL_TEXT_MAX と同じ)。
// MCP だけ上限が無いと、ここで入った長文を画面が触っただけで切ってしまう。
const GOAL_TEXT_MAX = 20000;
function assertTextLen(fields: Record<string, unknown>) {
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" && v.length > GOAL_TEXT_MAX) {
      throw new Error(`${k} は${GOAL_TEXT_MAX.toLocaleString()}字までです (今は${v.length.toLocaleString()}字)。長い資料はファイルか外部のURLにして、ここには要点とリンクを書いてください`);
    }
  }
}

type StepRow = { id: string; text: string; order_idx: number; done_at: string | null };
async function listTaskSteps(env: { DB: D1Database }, wsId: string, taskId: string): Promise<StepRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, text, order_idx, done_at FROM task_steps WHERE task_id = ? AND workspace_id = ? ORDER BY order_idx, created_at"
  ).bind(taskId, wsId).all<StepRow>();
  return results ?? [];
}

// 親の完了の基準のどの行を埋めるタスクか (closes) を確かめる。親に基準が無い・行が見つからないときは理由を投げる。
function closesOrThrow(parentCriteria: string | null, closes: string | undefined, parentId: string): string {
  if (!parentCriteria?.trim()) {
    throw new Error(`親 (${parentId}) に完了の基準がありません。タスクは「親の完了の基準」と「親の現状」の差から足すので、先に update_goal で親の完了の基準を書いてください`);
  }
  const list = numberedCriteria(parentCriteria);
  if (!closes?.trim()) {
    throw new Error(`closes が要ります。このタスクが埋める親の完了の基準の行を、行番号か文の一部で渡してください。親の完了の基準:\n${list}\nどの行にも当たらないタスクなら、足す前に親の完了の基準が足りていないかを考え、要るなら update_goal で基準を直してください (本人の確認が出ます)`);
  }
  const line = matchCriteriaLine(parentCriteria, closes);
  if (!line) throw new Error(`closes「${closes.slice(0, 60)}」が親の完了の基準のどの行にも当たりません。行番号か、その行の文の一部で渡してください。親の完了の基準:\n${list}`);
  return line;
}

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
      "kata が付いていたら、それがこの仕事の型 (資料・注意点・以前のやり方)。手を動かす前に読む。" +
      "files はこのタスクと上のゴール (顧客の箱など) に付いた資料 (近い順)。探しに行く前にここを見る。",
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
      const kata = await kataForGoal(env.DB, wsId, { id: args.id, ...g }, env.AI, kataExportTarget(env as unknown as Record<string, unknown>), templateViewerOf(auth));
      const steps = await listTaskSteps(env, wsId, args.id);
      const files = await inheritedResources(env.DB, wsId, args.id, 30);
      return {
        ...(row as object),
        task_progress: p.text,
        ...(files.length ? { files, files_note: FILES_NOTE } : {}),
        current_state_is_stale: p.stale,
        ...(steps.length ? { steps } : {}),
        ...((row as { stalled_at?: string | null }).stalled_at ? { stalled_note_for_ai: "このタスクは進行中のまま24時間以上動かず止まっていた (stalled_note)。続けるなら start_task、終わっているなら complete_subtask、やめるなら update_goal で archived。どれかをすると印は消える" } : {}),
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
      completion_criteria: z.string().optional().describe(`${COMPLETION_CRITERIA_DOC}\n必須。甘いと受け付けない`),
      current_state: z.string().optional().describe(`${CURRENT_STATE_DOC}\n必須 (日付とボールの行が無いと受け付けない)`),
      closes: z.string().optional().describe("parentId を渡すとき必須。親の完了の基準のどの行を満たすためのゴールか (行番号か、その行の文の一部)"),
    }),
    handler: async (args, env, wsId, auth) => {
      // 目標 → 完了の基準 → 現状 → 差がタスク。甘い基準・現状は受け付けない (qualityCore)
      const cp = criteriaProblem(args.completion_criteria);
      if (cp) throw new Error(cp);
      const sp = stateProblem(args.current_state);
      if (sp) throw new Error(sp);
      // a scoped session may only create inside its subtrees — default to the
      // scope root when there is exactly one, otherwise the caller must pick
      const parentId: string | null =
        args.parentId ?? (auth.scopeRoots && auth.scopeRoots.length === 1 ? auth.scopeRoots[0] : null);
      let closesLine: string | null = null;
      if (auth.scopeRoots && !parentId) {
        throw new Error("parentId is required: 複数のゴールにアサインされているため、どのゴール配下に作成するか parentId で指定してください");
      }
      assertTextLen({ name: args.name, completion_criteria: args.completion_criteria, current_state: args.current_state });
      if (parentId) {
        await assertGoalInScope(env, auth, parentId);
        await assertCanEdit(env, wsId, auth, parentId);
        const parent = await env.DB.prepare("SELECT id, completion_criteria FROM projects WHERE id = ? AND workspace_id = ? AND status != 'archived'").bind(parentId, wsId).first<{ id: string; completion_criteria: string | null }>();
        if (!parent) throw new Error(`parent goal not found: ${parentId}`);
        closesLine = closesOrThrow(parent.completion_criteria, args.closes, parentId);
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
      if (closesLine) await env.DB.prepare("UPDATE projects SET closes_criteria = ? WHERE id = ? AND workspace_id = ?").bind(closesLine, id, wsId).run();
      await requestConfirmation(env.DB, { wsId, goalId: id, field: "completion_criteria", before: null, after: formatFieldText(args.completion_criteria!), applied: true, reason: "新しく作ったゴールの完了の基準", userId: auth.actor?.userId ?? null, userName: auth.actor?.name ?? null, now: created });
      await clearStartedOnParent(env, wsId, parentId);
      const assignee =
        (await assignCreatorAsHolder(env, wsId, id, auth.actor)) ??
        (await inheritAssigneeFromAncestors(env, wsId, id, parentId));
      const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(id, wsId).first();
      return { ...(row as object), assigned_member_id: assignee, confirmation_note: CONFIRM_NOTE_APPLIED };
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
      assertTextLen({ name: args.name, current_state: args.current_state, completion_criteria: args.completion_criteria });
      // 状態と期日は画面 (app/lib/server/queries/goals.ts の updateGoal) と同じ値だけ受ける。
      // 決まっていない状態 (completed・foo など) は完了とも未完了とも扱えず一覧に残り続け、
      // 「来週金曜」のような期日は画面の期日欄に出ない。
      if (args.status !== undefined && !["active", "done", "archived"].includes(args.status)) {
        throw new Error(`status は active / done / archived のどれかにしてください (完了にするなら complete_subtask)`);
      }
      if (args.deadline !== undefined) {
        if (args.deadline === "") args.deadline = null;
        else {
          const m = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(args.deadline);
          const day = m?.[1];
          if (!day || Number.isNaN(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
            throw new Error(`deadline は YYYY-MM-DD の実在する日付にしてください (受け取った値: ${args.deadline.slice(0, 40)})`);
          }
          args.deadline = day;
        }
      }
      if (args.current_state !== undefined) args.current_state = formatFieldText(args.current_state);
      if (args.completion_criteria !== undefined) args.completion_criteria = formatFieldText(args.completion_criteria);
      // 甘い完了の基準・現状は受け付けない。既にある完了の基準の書き換えは、本人の「はい」まで反映しない
      if (args.completion_criteria !== undefined) { const p = criteriaProblem(args.completion_criteria); if (p) throw new Error(p); }
      if (args.current_state !== undefined) { const p = stateProblem(args.current_state); if (p) throw new Error(p); }
      const before = await env.DB.prepare("SELECT completion_criteria, current_state FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId)
        .first<{ completion_criteria: string | null; current_state: string | null }>();
      if (!before) throw new Error(`goal not found: ${args.id}`);
      const now0 = nowIso();
      const who = { userId: auth.actor?.userId ?? null, userName: auth.actor?.name ?? null };
      const notes: Record<string, string> = {};
      if (args.completion_criteria !== undefined && args.completion_criteria !== (before.completion_criteria ?? "")) {
        if (before.completion_criteria?.trim()) {
          const cid = await requestConfirmation(env.DB, { wsId, goalId: args.id, field: "completion_criteria", before: before.completion_criteria, after: args.completion_criteria, applied: false, ...who, now: now0 });
          notes.completion_criteria_pending = cid;
          notes.confirmation_note = CONFIRM_NOTE_PENDING;
          args.completion_criteria = undefined; // はいで反映する
        } else {
          await requestConfirmation(env.DB, { wsId, goalId: args.id, field: "completion_criteria", before: null, after: args.completion_criteria, applied: true, ...who, now: now0 });
          notes.confirmation_note = CONFIRM_NOTE_APPLIED;
        }
      }
      if (args.current_state !== undefined && args.current_state !== (before.current_state ?? "")) {
        await requestConfirmation(env.DB, { wsId, goalId: args.id, field: "current_state", before: before.current_state, after: args.current_state, applied: true, ...who, now: now0 });
        notes.confirmation_note = notes.confirmation_note ? `${notes.confirmation_note}\n${CONFIRM_NOTE_APPLIED}` : CONFIRM_NOTE_APPLIED;
      }
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
        // 現状を書き直した = 動いたので「止まっている」を外す
        fields.push("stalled_at = CASE WHEN current_state IS NOT ? THEN NULL ELSE stalled_at END", "stalled_note = CASE WHEN current_state IS NOT ? THEN NULL ELSE stalled_note END");
        binds.push(args.current_state, args.current_state);
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
      if (fields.length === 0) {
        if (notes.completion_criteria_pending) {
          const cur = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first();
          return { ...(cur as object), ...notes };
        }
        throw new Error("no fields to update");
      }
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
      const out = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first();
      return { ...(out as object), ...notes };
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
        const dest = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND status != 'archived'").bind(newParentId, wsId).first();
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
      // 上の循環チェックと付け替えの間に別の移動が割り込むと循環ができる。判定と書き込みを1文にする
      // (app/lib/server/queries/goals.ts の moveGoal と同じ)
      const moved = await env.DB.prepare(
        `UPDATE projects SET parent_goal_id = ?1 WHERE id = ?2 AND workspace_id = ?3
           AND (?1 IS NULL OR NOT EXISTS (
             WITH RECURSIVE anc(id) AS (
               SELECT ?1
               UNION
               SELECT p.parent_goal_id FROM anc JOIN projects p ON p.id = anc.id AND p.workspace_id = ?3
                WHERE p.parent_goal_id IS NOT NULL
             )
             SELECT 1 FROM anc WHERE id = ?2
           ))`
      ).bind(newParentId, id, wsId).run();
      if (!moved.meta.changes) throw new Error("cannot move a goal under its own descendant");
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
      "人が頼んだ単位のタスクを足す (盤に1行として並ぶ)。AI が作業を進めるための手順 (「資料を読む」「下書きを作る」など) はここに作らず add_steps でタスクの中に持たせる。" +
      "手順を子タスクにすると人が頼んだタスクと同じ盤に並び、名前と中身がずれたタスクとして残る。" +
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
        "必須。この小タスクの完了の基準。1〜2行で「何ができたら終わりか」を、他人が○×を付けられる形で書く (成果物名・数値・確認方法のどれかを入れる)。例: 「原稿3本を 20_法務/ に置き、本番ビルドで 404 になることを確認」。甘いと受け付けない"
      ),
      current_state: z.string().optional().describe("必須。作る時点の現状。何日時点か・分かっている前提・「ボール: 次に動く人」を書く。例: 「2026-11-02時点。未着手。先方の資料は受領済み。ボール: こちら」"),
      closes: z.string().optional().describe("必須。このタスクが埋める、親の完了の基準の行 (行番号か、その行の文の一部)。タスクは「親の完了の基準 − 親の現状」の差を埋めるものだけ足す"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      await assertCanEdit(env, wsId, auth, args.goalId);
      assertTextLen({ text: args.text, completion_criteria: args.completion_criteria, current_state: args.current_state });
      // 削除 (アーカイブ) 済みの親には足さない。親が一覧に無いので子だけがトップに浮く
      const goal = await env.DB.prepare("SELECT id, completion_criteria, current_state FROM projects WHERE id = ? AND workspace_id = ? AND status != 'archived'").bind(args.goalId, wsId)
        .first<{ id: string; completion_criteria: string | null; current_state: string | null }>();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      // 目標 → 完了の基準 → 現状 → 差がタスク。親の基準・現状が無いところにタスクは足せない
      if (!goal.current_state?.trim()) throw new Error(`親 (${args.goalId}) の現状が空です。タスクは「親の完了の基準」と「親の現状」の差から足すので、先に update_goal で親の現状 (日付・済んだこと・ボール・残り) を書いてください`);
      const closesLine = closesOrThrow(goal.completion_criteria, args.closes, args.goalId);
      { const p = criteriaProblem(args.completion_criteria); if (p) throw new Error(p); }
      { const p = stateProblem(args.current_state); if (p) throw new Error(p); }
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
                               completion_criteria, current_state, criteria_updated_at, state_updated_at, closes_criteria)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, args.text.trim(), args.goalId, orderIdx, created, wsId,
          criteria, state, criteria ? created : null, state ? created : null, closesLine)
        .run();
      await requestConfirmation(env.DB, { wsId, goalId: id, field: "completion_criteria", before: null, after: criteria!, applied: true, reason: `親の基準「${closesLine.slice(0, 80)}」を埋めるタスク`, userId: auth.actor?.userId ?? null, userName: auth.actor?.name ?? null, now: created });
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
        confirmation_note: CONFIRM_NOTE_APPLIED,
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
          `UPDATE projects SET started_at = ?, started_by = ?, started_by_name = ?, started_via = ?, ${CLEAR_STALL_SET}
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
      const kata = args.started !== false && row.status === "active" ? await kataForGoal(env.DB, wsId, { id: args.id, ...row }, env.AI, kataExportTarget(env as unknown as Record<string, unknown>), templateViewerOf(auth)) : null;
      const files = args.started !== false && row.status === "active" ? await inheritedResources(env.DB, wsId, args.id, 30) : [];
      return { ...(row as object), note, ...(files.length ? { files, files_note: FILES_NOTE } : {}), ...(kata ? { kata, kata_note: kataNote(kata, "start") } : {}) };
    },
  },

  add_steps: {
    description:
      "作業の手順をタスクの中のチェックリストとして足す。AI がタスクに着手するとき、手を動かす前に 2〜5個を1回で渡す。" +
      "手順は盤 (タスクの一覧) には出ず、そのタスクを開いた人にだけ「作業の手順 2/4」として見える。人が頼んだ単位のタスクを増やすときは add_subtask。" +
      "1つ終わるごとに check_step。全部済んだらタスク本体を complete_subtask (手順を全部チェックしてもタスクは自動では閉じない)。",
    schema: z.object({
      taskId: z.string().min(1).describe("手順を持たせるタスクの id (今から手を動かすタスク)"),
      steps: z.array(z.string().min(1).max(200)).min(1).max(12).describe("手順の文。1つ = 1アクション。終わったかどうかが判定できる形で書く (例: 「請求書PDFを作って 10_財務/請求/ に置く」)"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.taskId);
      await assertCanEdit(env, wsId, auth, args.taskId);
      const t = await env.DB.prepare("SELECT id, status FROM projects WHERE id = ? AND workspace_id = ?").bind(args.taskId, wsId).first<{ id: string; status: string }>();
      if (!t || t.status === "archived") throw new Error(`task not found: ${args.taskId}`);
      const who = await resolveCreator(env, wsId, auth.actor);
      const max = await env.DB.prepare("SELECT COALESCE(MAX(order_idx), -1) AS m FROM task_steps WHERE task_id = ? AND workspace_id = ?").bind(args.taskId, wsId).first<{ m: number }>();
      let idx = (max?.m ?? -1) + 1;
      const now = nowIso();
      await env.DB.batch([
        ...args.steps.map((text: string) =>
          env.DB.prepare("INSERT INTO task_steps (id, task_id, workspace_id, text, order_idx, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(uid(), args.taskId, wsId, text.trim(), idx++, now, who?.name ?? null)
        ),
        env.DB.prepare(`UPDATE projects SET ${CLEAR_STALL_SET} WHERE id = ? AND workspace_id = ? AND stalled_at IS NOT NULL`).bind(args.taskId, wsId),
      ]);
      const steps = await listTaskSteps(env, wsId, args.taskId);
      return { task_id: args.taskId, steps, note: "手を動かす前に start_task でこのタスクを進行中にする。手順が1つ終わるたびに check_step。" };
    },
  },

  check_step: {
    description:
      "作業の手順 (add_steps で足したもの) を済みにする。1つ終わるたびに呼ぶ (まとめて最後に付けない。人は途中経過を見ている)。" +
      "done=false で済みを外す。完了の照合は要らない (タスク本体を閉じるときに照合する)。",
    schema: z.object({
      id: z.string().min(1).describe("手順の id (add_steps / get_goal の steps[].id)"),
      done: z.boolean().optional().describe("false で済みを外す (既定 true)"),
    }),
    handler: async (args, env, wsId, auth) => {
      const s = await env.DB.prepare("SELECT task_id FROM task_steps WHERE id = ? AND workspace_id = ?").bind(args.id, wsId).first<{ task_id: string }>();
      if (!s) throw new Error(`step not found: ${args.id}`);
      await assertGoalInScope(env, auth, s.task_id);
      await assertCanEdit(env, wsId, auth, s.task_id);
      const now = nowIso();
      await env.DB.batch([
        env.DB.prepare("UPDATE task_steps SET done_at = ? WHERE id = ? AND workspace_id = ?").bind(args.done === false ? null : now, args.id, wsId),
        env.DB.prepare(`UPDATE projects SET ${CLEAR_STALL_SET} WHERE id = ? AND workspace_id = ? AND stalled_at IS NOT NULL`).bind(s.task_id, wsId),
      ]);
      const steps = await listTaskSteps(env, wsId, s.task_id);
      const open = steps.filter((x) => !x.done_at);
      return {
        task_id: s.task_id,
        steps,
        note: open.length
          ? `残り ${open.length} 個。次は「${open[0].text}」`
          : "手順は全部済んだ。完了基準と照らして満たしていれば、タスク本体を complete_subtask で閉じる (current_state に結果を書く)。満たしていなければ足りない手順を add_steps で足す",
      };
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
      parent_current_state: z.string().optional().describe(
        "完了にするとき、親があるなら必須。このタスクが終わった後の親の現状を丸ごと書き直したもの (日付・済んだこと・ボール・残り)。" +
        "タスクが動いたのに親の現状が古いままだと、次に何をするか誰にも分からなくなるため、同じ呼び出しで書き直す。親の完了の基準を満たしたならそれも書く"
      ),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.id);
      await assertCanEdit(env, wsId, auth, args.id);
      assertTextLen({ current_state: args.current_state, parent_current_state: args.parent_current_state });
      const pre = await env.DB.prepare("SELECT parent_goal_id, status FROM projects WHERE id = ? AND workspace_id = ?").bind(args.id, wsId)
        .first<{ parent_goal_id: string | null; status: string }>();
      if (!pre) throw new Error(`subtask not found: ${args.id}`);
      let parentStateBefore: string | null = null;
      if (args.completed) {
        { const p = resultProblem(args.current_state); if (p) throw new Error(p); }
        if (pre.parent_goal_id) {
          if (!args.parent_current_state?.trim()) {
            throw new Error("parent_current_state が要ります。このタスクを終えたあとの親の現状 (日付・済んだこと・ボール・残り) を書き直して、同じ呼び出しで渡してください。タスクが動いたのに親の現状が古いままだと、次に何をするか分からなくなります");
          }
          const p = stateProblem(args.parent_current_state);
          if (p) throw new Error(`parent_current_state: ${p}`);
          if (await goalInScope(env, auth, pre.parent_goal_id) && await canEditGoal(env, wsId, auth, pre.parent_goal_id)) {
            const pr = await env.DB.prepare("SELECT current_state FROM projects WHERE id = ? AND workspace_id = ?").bind(pre.parent_goal_id, wsId).first<{ current_state: string | null }>();
            parentStateBefore = pr?.current_state ?? null;
          } else {
            args.parent_current_state = undefined; // 親を直せない人 (子だけ担当) は、親の現状を書き換えない
          }
        }
      }
      const status = args.completed ? "done" : "active";
      // completed_at を残す。projects には status='done' しか無かったため
      // 「いつ終わったか」が一切残らず、速度も「提案は実行されたか」も測れなかった
      // (done_log は nodes 側の完了しか書かない)。
      // completed_by は「終えたタスク」の数え上げ用 (0025)。AI が閉じたらトークンの持ち主の完了として数える
      const res = await env.DB.prepare(
        // 削除 (アーカイブ) 済みは done/active に戻さない (一覧に復活していた)
        `UPDATE projects SET status = ?, completed_at = ?, completed_by = ?, ${CLEAR_STALL_SET} WHERE id = ? AND workspace_id = ? AND status != 'archived'`
      )
        .bind(status, args.completed ? nowIso() : null, args.completed ? (auth.actor?.email?.toLowerCase().trim() || null) : null, args.id, wsId)
        .run();
      if (!res.meta.changes) throw new Error(`subtask not found (or archived): ${args.id}`);
      if (args.current_state?.trim()) {
        await env.DB.prepare("UPDATE projects SET current_state = ?, state_updated_at = ? WHERE id = ? AND workspace_id = ?")
          .bind(args.current_state.trim(), nowIso(), args.id, wsId).run();
      }
      // 親の現状を同じ呼び出しで書き直し、本人に「これでいい？」を出す
      if (args.completed && pre.parent_goal_id && args.parent_current_state?.trim()) {
        const ps = formatFieldText(args.parent_current_state);
        const t = nowIso();
        await env.DB.prepare(`UPDATE projects SET current_state = ?, state_updated_at = ?, ${CLEAR_STALL_SET} WHERE id = ? AND workspace_id = ?`)
          .bind(ps, t, pre.parent_goal_id, wsId).run();
        await requestConfirmation(env.DB, { wsId, goalId: pre.parent_goal_id, field: "current_state", before: parentStateBefore, after: ps, applied: true, reason: "子タスクを終えたので親の現状を書き直した", userId: auth.actor?.userId ?? null, userName: auth.actor?.name ?? null, now: t });
      }
      if (args.completed) {
        // 親を完了したら配下も完了にする (queries.ts の cascadeGoalDone と同じ挙動)。
        // 伝播させないと閉じた親の下に未完のものが残り、一覧・検索・「今日」に出続ける。
        // ゴールだけでなく、ゴールがぶら下げている小タスク (nodes) も閉じること。
        await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM projects WHERE id = ?1 AND workspace_id = ?2
             UNION
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
             UNION
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
        const kata = await kataForGoal(env.DB, wsId, { id: args.id, ...row }, env.AI, kataExportTarget(env as unknown as Record<string, unknown>), templateViewerOf(auth));
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
