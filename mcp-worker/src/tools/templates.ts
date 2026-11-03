// MCP ツール (templates)。index.ts の tools から切り出し。
import { z } from "zod";
import { applyTemplate, snapshotGoalTree, parseTemplateRow, normalizeInputs, normalizeTasks, normalizeResources, normalizeCautions, normalizeValues, missingRequiredInputs, substitute, outlineToTasks, tasksToOutline, countTasks, saveTemplate, listTemplateRevisions, revertTemplateRevision, exportTemplate, buildKataMarkdown, RESOURCE_KINDS, LIMITS as TEMPLATE_LIMITS, TEMPLATE_FUNCTIONS, TEMPLATE_VISIBILITIES, VISIBILITY_LABEL, DEFAULT_VISIBILITY, LIMIT_PRIVATE_NOTE, templateReadableSql, templateReadableBinds, redactTemplate, describeSchedule, routineSetupText, normalizeScheduleTarget, checkScheduleSettings, saveTemplateSettings, type Template, type TemplateCaution, type TemplatePatch, type TemplateRow } from "../../../app/lib/server/templateCore";
import { ToolDef, assertAdmin, assertCanEdit, assertGoalInScope, assertTemplateManager, findTemplate, templateViewerOf, goalInScope, nowIso, recordRecipients, resolveWho, uid, decodeBase64, safeFileName, MAX_FILE_BYTES, type McpAuth } from "../lib";
import { safeContentType } from "../../../app/lib/server/filesCore";
import { isAncestorOfAny } from "../../../app/lib/server/resourcesCore";
import type { Env } from "../env";
import { playbooksForTemplate, templateIdForGoal } from "../kata";

// 資料 1 件。why (何のために見るか) は必須: URL だけ貼ってある状態を無くすため。
// url は外のリンクか、upload_template_file で上げた型のファイル (r2:…)
const resourceSchema = z.object({
  kind: z.enum(RESOURCE_KINDS).describe("やり方 = 前回どうやったかの手順書 / 実物 = 実際に出した成果物 / 置き場所 = 型の本文の正本 / 情報源 = 参考にするもの"),
  name: z.string().max(TEMPLATE_LIMITS.resourceName).optional(),
  url: z.string().url().max(TEMPLATE_LIMITS.resourceUrl),
  why: z.string().min(1).max(TEMPLATE_LIMITS.resourceWhy).describe("何のために見るか (1 行)。例: 顔の大きさと文字量の基準を見る"),
});
const RESOURCES_DOC = "資料 (外部 URL)。本文はこつこつに入れず外に置き、ここには 種類・URL・何のために見るか だけを書く。振ると新しいゴールのリソースに付く";
const CAUTIONS_DOC = "注意点。1 件 1 行で、守らないと差し戻される所を書く (例: 実在の他人の顔を許諾なしで使わない)";

// 型を見せるときの共通の形 (履歴と結んだ前例を添える)
// 直せない人には自分だけのメモと振る先を外す。直せる人には AI の定期実行の組み方 (routine_setup) を添える
async function templateView(env: Env, wsId: string, t: Template, auth: McpAuth) {
  const [revisions, precedents] = await Promise.all([
    listTemplateRevisions(env.DB, wsId, t.id, 10),
    playbooksForTemplate(env.DB, wsId, t.id),
  ]);
  const v = redactTemplate(t, templateViewerOf(auth));
  return {
    ...v, visibility_label: VISIBILITY_LABEL[t.visibility], schedule_label: describeSchedule(t.schedule),
    ...(v.can_manage && t.schedule ? { routine_setup: routineSetupText(t) } : {}),
    tasks_outline: tasksToOutline(t.tasks), task_count: countTasks(t.tasks), precedents, revisions,
  };
}

// 型の Markdown の写しを型のファイル (r2:…) として置き直す。置き場所 (FILES) が無い環境では何もしない。
async function exportKata(env: Env, wsId: string, templateId: string) {
  const r = await exportTemplate(env.DB, wsId, templateId, env.FILES, nowIso());
  return r.error ? { export_error: r.error } : r.url ? { exported_to: r.url } : {};
}

function actorKind(auth: McpAuth): "human" | "ai" {
  // MCP から来る書き込みは AI が動かしている (人が画面で押した操作ではない)
  void auth;
  return "ai";
}

export const templatesTools: Record<string, ToolDef> = {
  // ---- members & access control (admin) ----
  // ---- 型 (テンプレート): 必要な入力値 + 資料リンク + タスクの木。人に振るための再利用の単位 ----
  // 中身の変換・適用は app/lib/server/templateCore.ts (Web と共有)。
  list_templates: {
    description: "型 (テンプレート) の一覧。型 = 必要な入力値 + 資料リンク + タスクの木。人に同じ種類の仕事を振るときは、先にここを見て合う型を探す。" +
      "自分が読める型だけ返す (見える範囲: 自分だけ / 振った相手も / 全員)。function (経営・財務・法務・集客・営業・CS・その他) の順に並ぶ。schedule があれば繰り返しで自動に振られる型。",
    schema: z.object({}),
    handler: async (_args, env, wsId, auth) => {
      const { results } = await env.DB.prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM projects p
                  WHERE p.template_id = t.id AND p.workspace_id = t.workspace_id AND p.status != 'archived'
                    AND NOT EXISTS (SELECT 1 FROM projects q WHERE q.id = p.parent_goal_id AND q.template_id = t.id)) AS used_count
           FROM templates t WHERE t.workspace_id = ? AND t.archived_at IS NULL AND ${templateReadableSql("t")} ORDER BY t.updated_at DESC LIMIT 200`
      ).bind(wsId, ...templateReadableBinds(templateViewerOf(auth))).all<TemplateRow & { used_count: number }>();
      const order = (f: string | null) => { const i = (TEMPLATE_FUNCTIONS as readonly string[]).indexOf(f ?? ""); return i < 0 ? TEMPLATE_FUNCTIONS.length : i; };
      return (results ?? []).map((r) => {
        const t = parseTemplateRow(r);
        return {
          id: t.id, name: t.name, function: t.function ?? "未分類", visibility: VISIBILITY_LABEL[t.visibility],
          ...(t.schedule ? { schedule: describeSchedule(t.schedule) } : {}),
          purpose: t.purpose, inputs: t.inputs,
          task_count: countTasks(t.tasks), resource_count: t.resources.length, caution_count: t.cautions.length,
          used_count: r.used_count, author: t.author_name, updated_at: t.updated_at,
        };
      }).sort((a, b) => order(a.function) - order(b.function));
    },
  },

  get_template: {
    description: "型 (テンプレート) の中身を読む。id か名前 (完全一致 → 部分一致) で指定。tasks は木、tasks_outline は 1 行 1 タスクの文字列 (2 スペースで 1 段深く、「 :: 」の後ろが完了の基準)。resources は資料 (種類・URL・何のために見るか)、cautions は注意点、precedents はこの型に結んだ前例 (以前のやり方)、revisions は直した履歴、goals はこの型から作ったゴール。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.name, p.status, p.created_at, p.completed_at, p.deadline FROM projects p
          WHERE p.template_id = ? AND p.workspace_id = ? AND p.status != 'archived'
            AND (p.parent_goal_id IS NULL OR p.parent_goal_id NOT IN (SELECT id FROM projects WHERE template_id = ? AND workspace_id = ?))
          ORDER BY p.created_at DESC LIMIT 50`
      ).bind(t.id, wsId, t.id, wsId).all();
      return { ...(await templateView(env, wsId, t, auth)), goals: results ?? [] };
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
      resources: z.array(resourceSchema).max(TEMPLATE_LIMITS.resources).optional().describe(RESOURCES_DOC),
      cautions: z.array(z.string().min(1).max(TEMPLATE_LIMITS.cautionText)).max(TEMPLATE_LIMITS.cautions).optional().describe(CAUTIONS_DOC),
      function: z.enum(TEMPLATE_FUNCTIONS).describe("この型が当たる機能。経営 / 財務 / 法務 / 集客 (問い合わせを作る) / 営業 (問い合わせを受注に・アウトバウンド) / CS (受注後) / その他"),
      visibility: z.enum(TEMPLATE_VISIBILITIES).optional().describe("見える範囲。private = 作った人と管理者だけ / assigned = 上 + この型から作ったゴールの担当者 (既定) / workspace = メンバー全員"),
      private_note: z.string().max(LIMIT_PRIVATE_NOTE).optional().describe("自分だけのメモ。作った人と管理者にしか見えない。道具の置き場所・アカウント・口座など、振った相手に見せないものはここに書き、purpose や resources には書かない"),
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
        `INSERT INTO templates (id, workspace_id, name, purpose, completion_criteria, inputs, tasks, resources, cautions, source_goal_id, created_by, author_name, created_at, updated_at, function, visibility, private_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, wsId, name.slice(0, TEMPLATE_LIMITS.name), args.purpose?.trim() || null, criteria || null,
        JSON.stringify(normalizeInputs(args.inputs ?? [])), JSON.stringify(tasks), JSON.stringify(normalizeResources(args.resources ?? []).filter((r) => !r.url.startsWith("r2:"))),
        JSON.stringify(normalizeCautions((args.cautions ?? []).map((text: string) => ({ text, added_at: now, added_by: auth.actor?.name ?? "AI" })))),
        args.from_goal_id ?? null, auth.actor?.userId ?? null, auth.actor?.name ?? null, now, now,
        args.function, args.visibility ?? DEFAULT_VISIBILITY, args.private_note?.trim() || null
      ).run();
      const ex = await exportKata(env, wsId, id);
      const t = await findTemplate(env, wsId, id, auth);
      return { ...(await templateView(env, wsId, t, auth)), ...ex };
    },
  },

  update_template: {
    description:
      "型 (テンプレート) の中身を直す。渡した項目だけ書き換える (resources・cautions は丸ごと置き換え)。tasks はアウトライン文字列か配列。直せるのは管理者と作った本人。" +
      "直すたびに履歴が残り、revert_template_change で戻せる。差し戻しから注意点を 1 行足すだけなら propose_template_change を使う。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
      name: z.string().min(1).max(TEMPLATE_LIMITS.name).optional(),
      purpose: z.string().max(TEMPLATE_LIMITS.purpose).nullable().optional(),
      completion_criteria: z.string().max(TEMPLATE_LIMITS.criteria).nullable().optional(),
      inputs: z.array(z.object({ label: z.string().min(1).max(TEMPLATE_LIMITS.inputLabel), hint: z.string().max(TEMPLATE_LIMITS.inputHint).optional(), required: z.boolean().optional() })).max(TEMPLATE_LIMITS.inputs).optional(),
      tasks: z.union([z.string(), z.array(z.any())]).optional(),
      resources: z.array(resourceSchema).max(TEMPLATE_LIMITS.resources).optional().describe(RESOURCES_DOC),
      cautions: z.array(z.string().min(1).max(TEMPLATE_LIMITS.cautionText)).max(TEMPLATE_LIMITS.cautions).optional().describe(`${CAUTIONS_DOC}。丸ごと置き換える (今ある注意点の出どころは、同じ文面なら引き継ぐ)`),
      reason: z.string().max(1000).optional().describe("なぜ直すか。履歴に残る"),
      function: z.enum(TEMPLATE_FUNCTIONS).optional().describe("この型が当たる機能 (経営 / 財務 / 法務 / 集客 / 営業 / CS / その他)"),
      visibility: z.enum(TEMPLATE_VISIBILITIES).optional().describe("見える範囲。private = 作った人と管理者だけ / assigned = 上 + この型から作ったゴールの担当者 / workspace = メンバー全員"),
      private_note: z.string().max(LIMIT_PRIVATE_NOTE).nullable().optional().describe("自分だけのメモ (作った人と管理者にしか見えない)。丸ごと置き換え"),
      schedule: z.object({
        freq: z.enum(["daily", "weekly", "monthly"]),
        time: z.string().regex(/^\d{1,2}:\d{2}$/).describe("ワークスペースのタイムゾーンの時刻 HH:MM"),
        weekday: z.number().int().min(0).max(6).optional().describe("weekly のとき。0=日〜6=土"),
        day: z.number().int().min(1).max(31).optional().describe("monthly のとき。月末を越える日はその月の最終日"),
      }).nullable().optional().describe("繰り返し。時刻にこつこつが今回分のゴールを作って担当の今日に入れる (前回分が終わっていなければ作らず知らせる)。null で止める。手を動かすのは AI の定期実行: 返り値の routine_setup どおりに組む"),
      schedule_target: z.object({
        parent_id: z.string().min(1).describe("置き場所の親ゴール id"),
        member_id: z.string().min(1).describe("担当の member id (list_members の id)"),
        values: z.record(z.string(), z.string()).optional().describe("毎回入れる入力値 {ラベル: 値}"),
        deadline_days: z.number().int().min(0).max(365).optional().describe("振った日から何日後を期限にするか"),
      }).nullable().optional().describe("繰り返しで振る先"),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
      assertTemplateManager(auth, t);
      const settings = { function: args.function, visibility: args.visibility, private_note: args.private_note, schedule: args.schedule, schedule_target: args.schedule_target };
      const hasSettings = Object.values(settings).some((x) => x !== undefined);
      if (args.schedule !== undefined || args.schedule_target !== undefined) {
        const schedule = args.schedule !== undefined ? args.schedule : t.schedule;
        const target = args.schedule_target !== undefined ? args.schedule_target : t.schedule_target;
        const why = await checkScheduleSettings(env.DB, wsId, t, schedule, target);
        if (why) throw new Error(why);
        const g = normalizeScheduleTarget(target);
        if (schedule && g) await assertCanEdit(env, wsId, auth, g.parent_id);
      }
      const patch: TemplatePatch = {};
      for (const k of ["name", "purpose", "completion_criteria", "inputs", "tasks", "resources"] as const) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (args.cautions !== undefined) {
        const prev = new Map(t.cautions.map((c) => [c.text, c]));
        patch.cautions = args.cautions.map((text: string) => prev.get(text.trim()) ?? { text, added_at: nowIso(), added_by: auth.actor?.name ?? "AI" });
      }
      if (!Object.keys(patch).length && !hasSettings) throw new Error("直す項目がありません");
      const r = Object.keys(patch).length
        ? await saveTemplate(env.DB, wsId, t, patch, { actorName: auth.actor?.name ?? "AI", actorKind: actorKind(auth), reason: args.reason ?? null, now: nowIso() })
        : { changed: false, revisionId: null };
      if (hasSettings) await saveTemplateSettings(env.DB, wsId, t.id, settings, nowIso());
      const ex = r.changed ? await exportKata(env, wsId, t.id) : {};
      const u = await findTemplate(env, wsId, t.id, auth);
      return { ...(await templateView(env, wsId, u, auth)), changed: r.changed, revision_id: r.revisionId, ...ex };
    },
  },

  upload_template_file: {
    description:
      "型の資料にファイルを足す (画像・PDF・動画など。こつこつの置き場所に保存し、型の資料に「種類・名前・何のために見るか」付きで載せる)。" +
      "1 回 1 ファイル、25MB まで (それより大きいものは型の画面から上げる。画面は 2GB まで)。直せるのは管理者と型を作った本人。直した履歴が残る。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
      filename: z.string().min(1).max(200).describe("ファイル名。例: 公開したサムネ.png"),
      contentBase64: z.string().min(1).describe("ファイルの中身 (base64)"),
      mimeType: z.string().optional().describe("例: image/png"),
      kind: z.enum(RESOURCE_KINDS).optional().describe("やり方 / 実物 / 置き場所 / 情報源。既定は 実物"),
      why: z.string().min(1).max(TEMPLATE_LIMITS.resourceWhy).describe("何のために見るか (1 行)"),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
      assertTemplateManager(auth, t);
      if (!env.FILES) throw new Error("ファイル置き場 (R2) が設定されていません");
      let bytes: Uint8Array;
      try { bytes = decodeBase64(args.contentBase64); } catch { throw new Error("invalid contentBase64: not valid base64"); }
      if (bytes.byteLength === 0) throw new Error("empty file");
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("ファイルが大きすぎます (25MBまで。大きいものは型の画面から上げてください)");
      const key = `${wsId}/templates/${t.id}/${uid()}-${safeFileName(args.filename)}`;
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: safeContentType(args.mimeType) } });
      const r = await saveTemplate(env.DB, wsId, t, {
        resources: [...t.resources, { kind: args.kind ?? "実物", name: args.filename.trim(), url: `r2:${key}`, why: args.why, size: bytes.byteLength }],
      }, { actorName: auth.actor?.name ?? "AI", actorKind: actorKind(auth), reason: `ファイルを足した: ${args.filename}`, now: nowIso() });
      const ex = r.changed ? await exportKata(env, wsId, t.id) : {};
      const u = await findTemplate(env, wsId, t.id, auth);
      return { ...(await templateView(env, wsId, u, auth)), changed: r.changed, revision_id: r.revisionId, file_key: key, ...ex };
    },
  },

  get_file: {
    description:
      "こつこつに上げたファイル (資料・リソースの url が r2: で始まるもの) を読む。key は r2: の後ろ。" +
      "4MB までは中身 (base64) を返す。それより大きいもの (動画など) は大きさと種類だけ返すので、画面で開いてもらう。",
    schema: z.object({ key: z.string().min(1).describe("r2: の後ろのキー (r2: 付きでもよい)") }),
    handler: async (args, env, wsId, auth) => {
      const key = args.key.replace(/^r2:/, "");
      const parts = key.split("/");
      if (parts[0] !== wsId || parts.some((p: string) => !p || p === "..")) throw new Error("file not found");
      if (parts[1] === "templates") {
        await findTemplate(env, wsId, parts[2], auth); // 型のファイルは型を読める人だけ (見える範囲)
      } else if (!(await goalInScope(env, auth, parts[1])) && !(auth.scopeRoots && await isAncestorOfAny(env.DB, wsId, parts[1], auth.scopeRoots))) {
        // 上のゴールのファイルは、その下のタスクを見られる人も読める (黒崎判断 2026-11-02)
        throw new Error("file not found");
      }
      if (!env.FILES) throw new Error("ファイル置き場 (R2) が設定されていません");
      const obj = await env.FILES.get(key);
      if (!obj) throw new Error("file not found");
      const name = parts[parts.length - 1].replace(/^[0-9a-f-]{36}-/, "");
      const type = obj.httpMetadata?.contentType ?? "application/octet-stream";
      if (obj.size > 4 * 1024 * 1024) {
        return { key, name, size: obj.size, content_type: type, note: "4MB を超えるので中身は返さない。画面 (型の画面・ゴールのリソース) で開いてもらう" };
      }
      const buf = new Uint8Array(await obj.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { key, name, size: obj.size, content_type: type, content_base64: btoa(bin) };
    },
  },

  get_template_markdown: {
    description:
      "型を Markdown 1 枚にして返す (読むだけ)。同じ中身の写しは、型を直すたびにサーバーが型のファイル (export_url の r2:…) に自動で置き直すので、どこかへ書き出す必要はない。",
    schema: z.object({ template: z.string().min(1).describe("型の id か名前") }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
      return { template_id: t.id, name: t.name, export_url: t.export_url ?? null, markdown: await buildKataMarkdown(env.DB, wsId, t, nowIso()) };
    },
  },

  record_template_export: {
    description: "型の Markdown の写しを、今すぐ型のファイルとして置き直す (ふだんは型を直すたびに自動で置かれるので呼ばなくてよい)。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
      url: z.string().optional().describe("使わない (前の GitHub 書き出しの名残り。渡しても無視する)"),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
      const r = await exportTemplate(env.DB, wsId, t.id, env.FILES, nowIso());
      if (r.error) throw new Error(`写しを置けませんでした: ${r.error}`);
      if (r.skipped) throw new Error("ファイルの置き場所 (R2) が設定されていません");
      return { ok: true, template_id: t.id, export_url: r.url };
    },
  },

  propose_template_change: {
    description:
      "差し戻し・訂正・照合の×から分かったことを型に足す。型は直されるたびに育つ (黒崎判断: 承認を待たずにそのまま反映し、履歴から戻せる)。" +
      "人がコメントで「ここ直して」と書いた、完了前の照合で注意点に×が付いた、型の手順と違うやり方の方が良かった、のどれかが起きたら呼ぶ。" +
      "source_goal_id にきっかけのタスクを渡すと、そのタスクの型 (祖先が型から作られていればその型) に足す。型を使ったことがある人と作った人に通知が飛ぶ。" +
      "注意点は「何をしない/何を守る」の 1 行に一般化する (顧客名・金額は書かない)。",
    schema: z.object({
      source_goal_id: z.string().min(1).describe("きっかけになったタスクの id (型から作ったタスク)"),
      template: z.string().min(1).optional().describe("型の id か名前。省略時は source_goal_id から辿る"),
      source_comment_id: z.string().optional().describe("きっかけになったコメントの id (list_comments の id)"),
      reason: z.string().min(4).max(1000).describe("何が起きて直すのか。例: 黒崎から「ストック写真風は差し戻し」とコメント"),
      add_cautions: z.array(z.string().min(4).max(TEMPLATE_LIMITS.cautionText)).max(10).optional().describe("足す注意点 (1 件 1 行)"),
      add_resources: z.array(resourceSchema).max(10).optional().describe("足す資料 (同じ URL は差し替え)"),
      tasks: z.union([z.string(), z.array(z.any())]).optional().describe("タスクの並びも直すときだけ。丸ごと置き換え (アウトライン文字列か配列)"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.source_goal_id);
      await assertCanEdit(env, wsId, auth, args.source_goal_id);
      const fromGoal = await templateIdForGoal(env.DB, wsId, args.source_goal_id);
      const t = await findTemplate(env, wsId, args.template ?? fromGoal ?? "", auth);
      // 型から作っていないタスクを口実に、関係ない型を直させない。管理者と型を作った本人だけは別
      if (fromGoal !== t.id) assertTemplateManager(auth, t);
      if (!args.add_cautions?.length && !args.add_resources?.length && args.tasks === undefined) throw new Error("足すもの (add_cautions / add_resources / tasks) がありません");
      const now = nowIso();
      const by = auth.actor?.name ?? "AI";
      const patch: TemplatePatch = {};
      if (args.add_cautions?.length) {
        const added: TemplateCaution[] = args.add_cautions.map((text: string) => ({
          text, source_goal_id: args.source_goal_id, ...(args.source_comment_id ? { source_comment_id: args.source_comment_id } : {}), added_at: now, added_by: by,
        }));
        patch.cautions = [...t.cautions, ...added];
      }
      if (args.add_resources?.length) {
        const urls = new Set(args.add_resources.map((r: { url: string }) => r.url));
        patch.resources = [...t.resources.filter((r) => !urls.has(r.url)), ...args.add_resources];
      }
      if (args.tasks !== undefined) patch.tasks = args.tasks;
      const r = await saveTemplate(env.DB, wsId, t, patch, {
        actorName: by, actorKind: actorKind(auth), reason: args.reason, sourceGoalId: args.source_goal_id, sourceCommentId: args.source_comment_id ?? null, now,
      });
      if (r.changed) await notifyTemplateChanged(env, wsId, t, args.source_goal_id, by, args.reason, auth);
      const ex = r.changed ? await exportKata(env, wsId, t.id) : {};
      const u = await findTemplate(env, wsId, t.id, auth);
      return { ...(await templateView(env, wsId, u, auth)), changed: r.changed, revision_id: r.revisionId, ...ex };
    },
  },

  revert_template_change: {
    description: "型の履歴 (get_template の revisions) の 1 版を取り消し、その版の直す前に戻す。戻した操作も履歴に残る。管理者と型を作った本人だけ。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
      revision_id: z.string().min(1).describe("取り消す版の id"),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
      assertTemplateManager(auth, t);
      const r = await revertTemplateRevision(env.DB, wsId, t, args.revision_id, { actorName: auth.actor?.name ?? "AI", actorKind: actorKind(auth), now: nowIso() });
      const ex = r.changed ? await exportKata(env, wsId, t.id) : {};
      const u = await findTemplate(env, wsId, t.id, auth);
      return { ...(await templateView(env, wsId, u, auth)), changed: r.changed, revision_id: r.revisionId, ...ex };
    },
  },

  link_playbook_to_template: {
    description:
      "前例 (record_playbook で残した以前のやり方) を型に結ぶ。結んだ前例は型の「やり方」として、get_template とこの型で進めるタスクの kata に出る。" +
      "型から作ったタスクで record_playbook した前例は自動で結ばれる。それ以外の前例を結ぶときに使う。unlink=true で外す。",
    schema: z.object({
      template: z.string().min(1).describe("型の id か名前"),
      playbook_id: z.string().min(1).describe("前例の id (precedents の playbook_id)"),
      unlink: z.boolean().optional(),
    }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
      assertTemplateManager(auth, t);
      const res = args.unlink
        ? await env.DB.prepare("UPDATE playbooks SET template_id = NULL WHERE id = ? AND workspace_id = ? AND template_id = ?").bind(args.playbook_id, wsId, t.id).run()
        : await env.DB.prepare("UPDATE playbooks SET template_id = ? WHERE id = ? AND workspace_id = ?").bind(t.id, args.playbook_id, wsId).run();
      if (!res.meta.changes) throw new Error(args.unlink ? "この型に結ばれていない前例です" : `前例が見つかりません: ${args.playbook_id}`);
      const ex = await exportKata(env, wsId, t.id);
      return { ok: true, template_id: t.id, precedents: await playbooksForTemplate(env.DB, wsId, t.id), ...ex };
    },
  },

  archive_template: {
    description: "型 (テンプレート) を一覧から外す (消さない。作ったゴールは残る)。管理者と作った本人だけ。",
    schema: z.object({ template: z.string().min(1).describe("型の id か名前") }),
    handler: async (args, env, wsId, auth) => {
      const t = await findTemplate(env, wsId, args.template, auth);
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
      const t = await findTemplate(env, wsId, args.template, auth);
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

// 型が育ったことを、型を作った人と、この型から作ったゴールの担当者に知らせる (直した本人は除く)
async function notifyTemplateChanged(env: Env, wsId: string, t: Template, goalId: string, by: string, reason: string, auth: McpAuth): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT lower(m.email) AS email FROM goal_members gm
       JOIN members m ON m.id = gm.member_id AND m.workspace_id = ?
       JOIN projects p ON p.id = gm.goal_id AND p.workspace_id = ?
      WHERE p.template_id = ? AND m.email IS NOT NULL
     UNION
     SELECT lower(u.email) FROM users u WHERE u.id = ?`
  ).bind(wsId, wsId, t.id, t.created_by ?? "").all<{ email: string | null }>();
  const self = auth.actor?.email?.toLowerCase();
  const emails = [...new Set((results ?? []).map((r) => r.email).filter((e): e is string => !!e && e !== self))];
  const now = nowIso();
  for (const email of emails) {
    const id = uid();
    await env.DB.prepare(
      "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'info', ?, ?, ?, ?, ?, ?)"
    ).bind(id, `型「${t.name}」が直されました`, `${by}: ${reason.slice(0, 200)}`, goalId, now, wsId, email).run();
    await recordRecipients(env, id, wsId, goalId, email);
  }
}
