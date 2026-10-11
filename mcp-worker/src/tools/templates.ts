// MCP ツール (templates)。index.ts の tools から切り出し。
import { z } from "zod";
import { applyTemplate, snapshotGoalTree, parseTemplateRow, normalizeInputs, normalizeTasks, normalizeResources, normalizeValues, missingRequiredInputs, substitute, outlineToTasks, tasksToOutline, countTasks, LIMITS as TEMPLATE_LIMITS, type TemplateRow } from "../../../app/lib/server/templateCore";
import { ToolDef, assertAdmin, assertCanEdit, assertGoalInScope, assertTemplateManager, findTemplate, nowIso, recordRecipients, resolveWho, uid } from "../lib";

export const templatesTools: Record<string, ToolDef> = {
  // ---- members & access control (admin) ----
  // ---- 型 (テンプレート): 必要な入力値 + 資料リンク + タスクの木。人に振るための再利用の単位 ----
  // 中身の変換・適用は app/lib/server/templateCore.ts (Web と共有)。
  list_templates: {
    description: "型 (テンプレート) の一覧。型 = 必要な入力値 + 資料リンク + タスクの木。人に同じ種類の仕事を振るときは、先にここを見て合う型を探す。",
    schema: z.object({}),
    handler: async (_args, env, wsId) => {
      const { results } = await env.DB.prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM projects p
                  WHERE p.template_id = t.id AND p.workspace_id = t.workspace_id AND p.status != 'archived'
                    AND NOT EXISTS (SELECT 1 FROM projects q WHERE q.id = p.parent_goal_id AND q.template_id = t.id)) AS used_count
           FROM templates t WHERE t.workspace_id = ? AND t.archived_at IS NULL ORDER BY t.updated_at DESC LIMIT 200`
      ).bind(wsId).all<TemplateRow & { used_count: number }>();
      return (results ?? []).map((r) => {
        const t = parseTemplateRow(r);
        return {
          id: t.id, name: t.name, purpose: t.purpose, inputs: t.inputs,
          task_count: countTasks(t.tasks), resource_count: t.resources.length,
          used_count: r.used_count, author: t.author_name, updated_at: t.updated_at,
        };
      });
    },
  },

  get_template: {
    description: "型 (テンプレート) の中身を読む。id か名前 (完全一致 → 部分一致) で指定。tasks は木、tasks_outline は 1 行 1 タスクの文字列 (2 スペースで 1 段深く、「 :: 」の後ろが完了の基準)。goals はこの型から作ったゴール。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
    }),
    handler: async (args, env, wsId) => {
      const t = await findTemplate(env, wsId, args.template);
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.name, p.status, p.created_at, p.completed_at, p.deadline FROM projects p
          WHERE p.template_id = ? AND p.workspace_id = ? AND p.status != 'archived'
            AND (p.parent_goal_id IS NULL OR p.parent_goal_id NOT IN (SELECT id FROM projects WHERE template_id = ? AND workspace_id = ?))
          ORDER BY p.created_at DESC LIMIT 50`
      ).bind(t.id, wsId, t.id, wsId).all();
      return { ...t, tasks_outline: tasksToOutline(t.tasks), task_count: countTasks(t.tasks), goals: results ?? [] };
    },
  },

  create_template: {
    description:
      "型 (テンプレート) を作る。from_goal_id を渡すと、そのゴールのタスク木 (完了の基準つき) を写して作る。name や inputs・tasks を一緒に渡せば上書きできる。" +
      "入力値 (顧客名・URL・件数など毎回変わるもの) は inputs に出し、タスク名や完了の基準には {{ラベル}} と書く。顧客名などの固有名詞は型本体に書かない。",
    schema: z.object({
      from_goal_id: z.string().min(1).optional().describe("写す元のゴール id。省略時は tasks を直接渡す"),
      name: z.string().min(1).max(TEMPLATE_LIMITS.name).optional().describe("型の名前。省略時は元ゴールの名前"),
      purpose: z.string().max(TEMPLATE_LIMITS.purpose).optional().describe("何のための型か・期待する成果"),
      completion_criteria: z.string().max(TEMPLATE_LIMITS.criteria).optional().describe("新しいゴールの完了の基準。{{ラベル}} 可"),
      inputs: z.array(z.object({ label: z.string().min(1).max(TEMPLATE_LIMITS.inputLabel), hint: z.string().max(TEMPLATE_LIMITS.inputHint).optional(), required: z.boolean().optional() })).max(TEMPLATE_LIMITS.inputs).optional(),
      tasks: z.union([z.string(), z.array(z.any())]).optional().describe("タスクの木。アウトライン文字列 (1 行 1 タスク、2 スペースで 1 段深く、「 :: 」の後ろが完了の基準) か、[{text, completion_criteria, children}] の配列"),
      resources: z.array(z.object({ name: z.string().max(TEMPLATE_LIMITS.resourceName).optional(), url: z.string().url().max(TEMPLATE_LIMITS.resourceUrl) })).max(TEMPLATE_LIMITS.resources).optional().describe("毎回同じ参照先 (手順書・ひな形)。振ると新しいゴールのリソースに付く"),
    }),
    handler: async (args, env, wsId, auth) => {
      let name = args.name?.trim() ?? "";
      let criteria = args.completion_criteria?.trim() ?? "";
      let tasks = typeof args.tasks === "string" ? outlineToTasks(args.tasks) : normalizeTasks(args.tasks ?? []);
      if (args.from_goal_id) {
        await assertGoalInScope(env, auth, args.from_goal_id);
        await assertCanEdit(env, wsId, auth, args.from_goal_id);
        const g = await env.DB.prepare("SELECT name, completion_criteria FROM projects WHERE id = ? AND workspace_id = ?")
          .bind(args.from_goal_id, wsId).first<{ name: string; completion_criteria: string | null }>();
        if (!g) throw new Error(`goal not found: ${args.from_goal_id}`);
        if (!name) name = g.name;
        if (!criteria) criteria = g.completion_criteria ?? "";
        if (!tasks.length) tasks = await snapshotGoalTree(env.DB, wsId, args.from_goal_id);
      } else {
        assertAdmin(auth);
      }
      if (!name) throw new Error("name が必要です (from_goal_id を渡すか name を入れてください)");
      const id = uid();
      const now = nowIso();
      await env.DB.prepare(
        `INSERT INTO templates (id, workspace_id, name, purpose, completion_criteria, inputs, tasks, resources, source_goal_id, created_by, author_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, wsId, name.slice(0, TEMPLATE_LIMITS.name), args.purpose?.trim() || null, criteria || null,
        JSON.stringify(normalizeInputs(args.inputs ?? [])), JSON.stringify(tasks), JSON.stringify(normalizeResources(args.resources ?? [])),
        args.from_goal_id ?? null, auth.actor?.userId ?? null, auth.actor?.name ?? null, now, now
      ).run();
      const t = await findTemplate(env, wsId, id);
      return { ...t, tasks_outline: tasksToOutline(t.tasks), task_count: countTasks(t.tasks) };
    },
  },

  update_template: {
    description: "型 (テンプレート) の中身を直す。渡した項目だけ書き換える。tasks はアウトライン文字列か配列。直せるのは管理者と作った本人。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
      name: z.string().min(1).max(TEMPLATE_LIMITS.name).optional(),
      purpose: z.string().max(TEMPLATE_LIMITS.purpose).nullable().optional(),
      completion_criteria: z.string().max(TEMPLATE_LIMITS.criteria).nullable().optional(),
      inputs: z.array(z.object({ label: z.string().min(1).max(TEMPLATE_LIMITS.inputLabel), hint: z.string().max(TEMPLATE_LIMITS.inputHint).optional(), required: z.boolean().optional() })).max(TEMPLATE_LIMITS.inputs).optional(),
      tasks: z.union([z.string(), z.array(z.any())]).optional(),
      resources: z.array(z.object({ name: z.string().max(TEMPLATE_LIMITS.resourceName).optional(), url: z.string().url().max(TEMPLATE_LIMITS.resourceUrl) })).max(TEMPLATE_LIMITS.resources).optional(),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template);
      assertTemplateManager(auth, t);
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (args.name !== undefined) { sets.push("name = ?"); vals.push(args.name.trim().slice(0, TEMPLATE_LIMITS.name)); }
      if (args.purpose !== undefined) { sets.push("purpose = ?"); vals.push(args.purpose?.trim() || null); }
      if (args.completion_criteria !== undefined) { sets.push("completion_criteria = ?"); vals.push(args.completion_criteria?.trim() || null); }
      if (args.inputs !== undefined) { sets.push("inputs = ?"); vals.push(JSON.stringify(normalizeInputs(args.inputs))); }
      if (args.tasks !== undefined) { sets.push("tasks = ?"); vals.push(JSON.stringify(typeof args.tasks === "string" ? outlineToTasks(args.tasks) : normalizeTasks(args.tasks))); }
      if (args.resources !== undefined) { sets.push("resources = ?"); vals.push(JSON.stringify(normalizeResources(args.resources))); }
      if (!sets.length) throw new Error("直す項目がありません");
      sets.push("updated_at = ?"); vals.push(nowIso(), t.id, wsId);
      await env.DB.prepare(`UPDATE templates SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`).bind(...vals).run();
      const u = await findTemplate(env, wsId, t.id);
      return { ...u, tasks_outline: tasksToOutline(u.tasks), task_count: countTasks(u.tasks) };
    },
  },

  archive_template: {
    description: "型 (テンプレート) を一覧から外す (消さない。作ったゴールは残る)。管理者と作った本人だけ。",
    schema: z.object({ template: z.string().min(1).describe("型の id か名前") }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template);
      assertTemplateManager(auth, t);
      await env.DB.prepare("UPDATE templates SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(nowIso(), nowIso(), t.id, wsId).run();
      return { ok: true, id: t.id };
    },
  },

  apply_template: {
    description:
      "型 (テンプレート) をメンバーに振る。parentId の下に 新しいゴール + 子タスク + リソース + 担当 を一度に作り、本人に通知する。" +
      "values は型の inputs のラベルをキーにした入力値。必須が空だと止まる (missing_inputs を返す) ので、推測で埋めず本人に聞く。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
      member: z.string().min(1).describe("担当者。名前・メール・member id のどれでも"),
      parentId: z.string().min(1).describe("置き場所の親ゴール id"),
      values: z.record(z.string(), z.string()).optional().describe("入力値 {ラベル: 値}"),
      deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("新しいゴールの期日 YYYY-MM-DD"),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template);
      await assertGoalInScope(env, auth, args.parentId);
      await assertCanEdit(env, wsId, auth, args.parentId);
      // 担当者: id → メール/名前 (resolveWho)
      let member = await env.DB.prepare("SELECT id, name, email FROM members WHERE id = ? AND workspace_id = ?")
        .bind(args.member, wsId).first<{ id: string; name: string; email: string | null }>();
      if (!member) {
        const who = await resolveWho(env, wsId, auth, args.member);
        member = await env.DB.prepare("SELECT id, name, email FROM members WHERE workspace_id = ? AND lower(email) = lower(?)")
          .bind(wsId, who.email).first<{ id: string; name: string; email: string | null }>();
        if (!member) throw new Error(`member not found: ${args.member}`);
      }
      const values = normalizeValues(args.values ?? {}, t.inputs);
      const missing = missingRequiredInputs(t.inputs, values);
      if (missing.length) return { ok: false, missing_inputs: missing, inputs: t.inputs, note: "必須の入力が空です。本人に聞いて values に入れてから呼び直してください" };
      const now = nowIso();
      const { rootId, created } = await applyTemplate(env.DB, wsId, t, {
        parentId: args.parentId,
        memberId: member.id,
        memberName: member.name,
        values,
        creatorUserId: auth.actor?.userId ?? null,
        creatorName: auth.actor?.name ?? null,
        deadline: args.deadline ?? null,
        now,
      });
      // 担当者本人に通知 (target_email 付きなので他の人には出ない)
      if (member.email) {
        const notifId = uid();
        const by = auth.actor?.name ?? "AI";
        await env.DB.prepare(
          "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'mention', ?, ?, ?, ?, ?, ?)"
        ).bind(notifId, `型「${substitute(t.name, values) || t.name}」のタスクが振られました`, `${by} → ${member.name}。タスク ${created} 件`, rootId, now, wsId, member.email.toLowerCase()).run();
        await recordRecipients(env, notifId, wsId, rootId, member.email);
      }
      const goal = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(rootId).first();
      return { ok: true, template: { id: t.id, name: substitute(t.name, values) || t.name }, goal, created, assigned_member_id: member.id };
    },
  },
};
