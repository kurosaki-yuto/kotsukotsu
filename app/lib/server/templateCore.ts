// 型 (テンプレート) の中身と、「ゴールの木 → 型」「型 → 新しいゴールの木」の変換。
// Web の API ルートと mcp-worker の両方から使うので、ここは純粋な関数だけ。
// `server-only` や platformEnv は import しない (mcp-worker は Next の外で束ねる)。
// D1 への読み書きは引数の db (D1Database) を通す。

export type TemplateInput = { label: string; hint?: string; required?: boolean };
export type TemplateTask = { text: string; completion_criteria?: string | null; children?: TemplateTask[] };
// 資料の種類。型は「どこを見ればいいか」の入口なので、資料ごとに何のための物かを分けて持つ。
export const RESOURCE_KINDS = ["やり方", "実物", "置き場所", "情報源"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
// why = 何のために見るか (1 行)。URL だけ貼ってある状態を無くすため、画面と MCP では必須にする。
// 10/14 以前の {name, url} だけの資料は kind=情報源・why 空 として読む。
export type TemplateResource = { kind: ResourceKind; name: string; url: string; why?: string };
// 注意点。差し戻し・照合の×から足されたものは、出どころのゴール・コメントを持つ。
export type TemplateCaution = { text: string; source_goal_id?: string; source_comment_id?: string; added_at?: string; added_by?: string };

export type TemplateRow = {
  id: string;
  workspace_id: string;
  name: string;
  purpose: string | null;
  completion_criteria: string | null;
  inputs: string;
  tasks: string;
  resources: string;
  cautions: string;
  source_goal_id: string | null;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  export_url?: string | null;
  exported_at?: string | null;
  embedding?: string | null;
  embedding_model?: string | null;
};

export type Template = Omit<TemplateRow, "inputs" | "tasks" | "resources" | "cautions" | "embedding" | "embedding_model"> & {
  inputs: TemplateInput[];
  tasks: TemplateTask[];
  resources: TemplateResource[];
  cautions: TemplateCaution[];
};

// 型の中身 (直した履歴に丸ごと残す範囲)
export type TemplateContent = Pick<Template, "name" | "purpose" | "completion_criteria" | "inputs" | "tasks" | "resources" | "cautions">;

// ---------- 上限。暴走した入力で D1 を詰まらせない ----------
export const LIMITS = {
  name: 200,
  purpose: 4000,
  criteria: 4000,
  inputs: 30,
  inputLabel: 60,
  inputHint: 300,
  resources: 30,
  resourceName: 120,
  resourceUrl: 2000,
  resourceWhy: 300,
  cautions: 50,
  cautionText: 500,
  tasks: 300, // 木全体のタスク数
  taskText: 500,
  taskCriteria: 2000,
  depth: 6,
  valueLen: 2000,
};

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// 入力欄の定義を検証して正規化する。壊れた要素は捨てる。
export function normalizeInputs(raw: unknown): TemplateInput[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateInput[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const label = str((it as { label?: unknown }).label, LIMITS.inputLabel);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const hint = str((it as { hint?: unknown }).hint, LIMITS.inputHint);
    const required = (it as { required?: unknown }).required === true;
    out.push({ label, ...(hint ? { hint } : {}), ...(required ? { required: true } : {}) });
    if (out.length >= LIMITS.inputs) break;
  }
  return out;
}

export function normalizeResources(raw: unknown): TemplateResource[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateResource[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const url = str((it as { url?: unknown }).url, LIMITS.resourceUrl);
    if (!url || !/^https?:\/\//i.test(url)) continue; // http(s) 以外 (javascript: 等) は入れない
    const name = str((it as { name?: unknown }).name, LIMITS.resourceName) || url;
    const k = str((it as { kind?: unknown }).kind, 10);
    const kind: ResourceKind = (RESOURCE_KINDS as readonly string[]).includes(k) ? (k as ResourceKind) : "情報源";
    const why = str((it as { why?: unknown }).why, LIMITS.resourceWhy).replace(/\s*\n\s*/g, " ");
    out.push({ kind, name, url, ...(why ? { why } : {}) });
    if (out.length >= LIMITS.resources) break;
  }
  return out;
}

// 「何のために見るか」が空の資料の名前。画面と MCP で保存前に止めるのに使う。
export function resourcesMissingWhy(list: TemplateResource[]): string[] {
  return list.filter((r) => !r.why?.trim()).map((r) => r.name);
}

export function normalizeCautions(raw: unknown): TemplateCaution[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateCaution[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    // 文字列だけの注意点も受ける (画面の 1 行 1 件の入力)
    const o = typeof it === "string" ? { text: it } : it;
    if (!o || typeof o !== "object") continue;
    const text = str((o as { text?: unknown }).text, LIMITS.cautionText).replace(/\s*\n\s*/g, " ");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const c: TemplateCaution = { text };
    for (const k of ["source_goal_id", "source_comment_id", "added_at", "added_by"] as const) {
      const v = str((o as Record<string, unknown>)[k], 200);
      if (v) c[k] = v;
    }
    out.push(c);
    if (out.length >= LIMITS.cautions) break;
  }
  return out;
}

// タスクの木を検証して正規化する。深さ・件数の上限を超えた分は切る。
export function normalizeTasks(raw: unknown): TemplateTask[] {
  let count = 0;
  const walk = (list: unknown, depth: number): TemplateTask[] => {
    if (!Array.isArray(list) || depth > LIMITS.depth) return [];
    const out: TemplateTask[] = [];
    for (const it of list) {
      if (count >= LIMITS.tasks) break;
      if (!it || typeof it !== "object") continue;
      const text = str((it as { text?: unknown }).text, LIMITS.taskText);
      if (!text) continue;
      count++;
      const cc = str((it as { completion_criteria?: unknown }).completion_criteria, LIMITS.taskCriteria);
      const children = walk((it as { children?: unknown }).children, depth + 1);
      out.push({ text, ...(cc ? { completion_criteria: cc } : {}), ...(children.length ? { children } : {}) });
    }
    return out;
  };
  return walk(raw, 1);
}

export function countTasks(tasks: TemplateTask[]): number {
  let n = 0;
  const walk = (l: TemplateTask[]) => { for (const t of l) { n++; if (t.children) walk(t.children); } };
  walk(tasks);
  return n;
}

export function parseTemplateRow(row: TemplateRow): Template {
  const safe = (s: string | null | undefined): unknown => { try { return JSON.parse(s ?? "[]"); } catch { return []; } };
  // 埋め込みは選ぶときにだけ使う。返り値に載せると 1 件 1.4KB の文字列が毎回 AI に流れる
  const { embedding: _e, embedding_model: _m, ...rest } = row;
  void _e; void _m;
  return {
    ...rest,
    inputs: normalizeInputs(safe(row.inputs)),
    tasks: normalizeTasks(safe(row.tasks)),
    resources: normalizeResources(safe(row.resources)),
    cautions: normalizeCautions(safe(row.cautions)),
  };
}

export function templateContent(t: TemplateContent): TemplateContent {
  return {
    name: t.name, purpose: t.purpose ?? null, completion_criteria: t.completion_criteria ?? null,
    inputs: t.inputs, tasks: t.tasks, resources: t.resources, cautions: t.cautions,
  };
}

// ---------- 型を直す (履歴つき) ----------
// Web の PATCH と MCP の update_template / propose_template_change / 戻す、の全部がここを通る。
// 直すたびに template_revisions に 変更前・変更後 を残す (修正は AI が自動で反映するので、戻せることが前提)。
export type TemplatePatch = Partial<Record<keyof TemplateContent, unknown>>;
export type RevisionMeta = {
  actorName: string | null;
  actorKind: "human" | "ai";
  reason?: string | null;
  sourceGoalId?: string | null;
  sourceCommentId?: string | null;
  now: string;
};

// tasks はアウトライン文字列 (1 行 1 タスク) でも木の配列でも受ける
const tasksOf = (v: unknown) => (typeof v === "string" ? outlineToTasks(v) : normalizeTasks(v));
const textOf = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;

export function mergeTemplatePatch(t: TemplateContent, patch: TemplatePatch): TemplateContent {
  const next = templateContent(t);
  if (patch.name !== undefined) { const n = textOf(patch.name, LIMITS.name); if (n) next.name = n; } // 名前は空にしない
  if (patch.purpose !== undefined) next.purpose = textOf(patch.purpose, LIMITS.purpose);
  if (patch.completion_criteria !== undefined) next.completion_criteria = textOf(patch.completion_criteria, LIMITS.criteria);
  if (patch.inputs !== undefined) next.inputs = normalizeInputs(patch.inputs);
  if (patch.tasks !== undefined) next.tasks = tasksOf(patch.tasks);
  if (patch.resources !== undefined) next.resources = normalizeResources(patch.resources);
  if (patch.cautions !== undefined) next.cautions = normalizeCautions(patch.cautions);
  return next;
}

/** 型を直して履歴を 1 行残す。中身が変わらなければ何もしない (changed=false)。 */
export async function saveTemplate(
  db: D1Database, wsId: string, t: Template, patch: TemplatePatch, meta: RevisionMeta
): Promise<{ changed: boolean; revisionId: string | null }> {
  const before = templateContent(t);
  const after = mergeTemplatePatch(before, patch);
  if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, revisionId: null };
  const revisionId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `UPDATE templates SET name = ?, purpose = ?, completion_criteria = ?, inputs = ?, tasks = ?, resources = ?, cautions = ?,
              embedding = NULL, embedding_model = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ?`
    ).bind(after.name, after.purpose, after.completion_criteria, JSON.stringify(after.inputs), JSON.stringify(after.tasks),
      JSON.stringify(after.resources), JSON.stringify(after.cautions), meta.now, t.id, wsId),
    db.prepare(
      `INSERT INTO template_revisions (id, workspace_id, template_id, before_json, after_json, reason, source_goal_id, source_comment_id, actor_name, actor_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(revisionId, wsId, t.id, JSON.stringify(before), JSON.stringify(after), meta.reason?.trim().slice(0, 1000) || null,
      meta.sourceGoalId ?? null, meta.sourceCommentId ?? null, meta.actorName, meta.actorKind, meta.now),
  ]);
  return { changed: true, revisionId };
}

export type TemplateRevision = {
  id: string; template_id: string; reason: string | null; actor_name: string | null; actor_kind: string;
  source_goal_id: string | null; source_comment_id: string | null; created_at: string; reverted_at: string | null; reverted_by: string | null;
  changes: string[];
};

// 1 版で何が変わったかを短く言う (履歴の一覧用)
export function describeChanges(before: TemplateContent, after: TemplateContent): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`名前: ${before.name} → ${after.name}`);
  if ((before.purpose ?? "") !== (after.purpose ?? "")) out.push("目的を直した");
  if ((before.completion_criteria ?? "") !== (after.completion_criteria ?? "")) out.push("完了の基準を直した");
  if (JSON.stringify(before.inputs) !== JSON.stringify(after.inputs)) out.push("入力を直した");
  if (JSON.stringify(before.tasks) !== JSON.stringify(after.tasks)) out.push(`タスク ${countTasks(before.tasks)} → ${countTasks(after.tasks)} 件`);
  const bc = new Set(before.cautions.map((c) => c.text));
  const ac = new Set(after.cautions.map((c) => c.text));
  for (const c of after.cautions) if (!bc.has(c.text)) out.push(`注意点を足した: ${c.text}`);
  for (const c of before.cautions) if (!ac.has(c.text)) out.push(`注意点を外した: ${c.text}`);
  const br = new Map(before.resources.map((r) => [r.url, r]));
  const ar = new Set(after.resources.map((r) => r.url));
  for (const r of after.resources) {
    const old = br.get(r.url);
    if (!old) out.push(`資料を足した: ${r.name}`);
    else if (JSON.stringify(old) !== JSON.stringify(r)) out.push(`資料を直した: ${r.name}`);
  }
  for (const r of before.resources) if (!ar.has(r.url)) out.push(`資料を外した: ${r.name}`);
  return out;
}

type RevisionRow = Omit<TemplateRevision, "changes"> & { before_json: string; after_json: string };
const parseContent = (s: string): TemplateContent => {
  const o = (() => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } })();
  return {
    name: typeof o.name === "string" ? o.name : "",
    purpose: typeof o.purpose === "string" ? o.purpose : null,
    completion_criteria: typeof o.completion_criteria === "string" ? o.completion_criteria : null,
    inputs: normalizeInputs(o.inputs), tasks: normalizeTasks(o.tasks),
    resources: normalizeResources(o.resources), cautions: normalizeCautions(o.cautions),
  };
};

export async function listTemplateRevisions(db: D1Database, wsId: string, templateId: string, limit = 30): Promise<TemplateRevision[]> {
  const { results } = await db.prepare(
    `SELECT * FROM template_revisions WHERE workspace_id = ? AND template_id = ? ORDER BY created_at DESC, id LIMIT ?`
  ).bind(wsId, templateId, limit).all<RevisionRow>();
  return (results ?? []).map(({ before_json, after_json, ...r }) => ({ ...r, changes: describeChanges(parseContent(before_json), parseContent(after_json)) }));
}

/** ある版で入った変更を取り消す (その版の「直す前」に戻す)。戻した操作も新しい版として残る。 */
export async function revertTemplateRevision(
  db: D1Database, wsId: string, t: Template, revisionId: string, meta: Omit<RevisionMeta, "reason">
): Promise<{ changed: boolean; revisionId: string | null }> {
  const rev = await db.prepare("SELECT * FROM template_revisions WHERE id = ? AND workspace_id = ? AND template_id = ?")
    .bind(revisionId, wsId, t.id).first<RevisionRow>();
  if (!rev) throw new Error(`revision not found: ${revisionId}`);
  const before = parseContent(rev.before_json);
  const r = await saveTemplate(db, wsId, t, before, { ...meta, reason: `${rev.created_at.slice(0, 10)} の変更を戻した${rev.reason ? ` (${rev.reason.slice(0, 80)})` : ""}` });
  await db.prepare("UPDATE template_revisions SET reverted_at = ?, reverted_by = ? WHERE id = ? AND workspace_id = ?")
    .bind(meta.now, meta.actorName, revisionId, wsId).run();
  return r;
}

// ---------- アウトライン表記 (画面と MCP の編集用) ----------
// 1 行 1 タスク。先頭の空白 2 つで 1 段深くなる。「 :: 」より後ろは完了の基準。
//   顧客のHPを読んで業種を確定する :: STATUS.md の業種欄が埋まっている
//     サブタスク
export function tasksToOutline(tasks: TemplateTask[]): string {
  const lines: string[] = [];
  const walk = (l: TemplateTask[], depth: number) => {
    for (const t of l) {
      const cc = t.completion_criteria ? ` :: ${t.completion_criteria.replace(/\s*\n\s*/g, " / ")}` : "";
      lines.push(`${"  ".repeat(depth)}${t.text.replace(/\s*\n\s*/g, " ")}${cc}`);
      if (t.children) walk(t.children, depth + 1);
    }
  };
  walk(tasks, 0);
  return lines.join("\n");
}

export function outlineToTasks(text: string): TemplateTask[] {
  const root: TemplateTask[] = [];
  const stack: { depth: number; list: TemplateTask[] }[] = [{ depth: -1, list: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const m = /^(\s*)(?:[-*・]\s*)?(.*)$/.exec(rawLine);
    if (!m) continue;
    // タブは 2 スペース扱い。全角スペースも 1 段扱い
    const indent = m[1].replace(/\t/g, "  ").replace(/　/g, "  ").length;
    const depth = Math.min(Math.floor(indent / 2), LIMITS.depth - 1);
    const [body, ...rest] = m[2].split(" :: ");
    const task: TemplateTask = { text: body.trim() };
    const cc = rest.join(" :: ").trim();
    if (cc) task.completion_criteria = cc;
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    parent.list.push(task);
    task.children = [];
    stack.push({ depth, list: task.children });
  }
  // 空の children を落とす
  const prune = (l: TemplateTask[]) => { for (const t of l) { if (t.children && t.children.length) prune(t.children); else delete t.children; } };
  prune(root);
  return normalizeTasks(root);
}

// ---------- {{ラベル}} の差し込み ----------
export function substitute(text: string | null | undefined, values: Record<string, string>): string {
  if (!text) return "";
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, key: string) => {
    const v = values[key.trim()];
    return v == null || v === "" ? whole : v;
  });
}

export function missingRequiredInputs(inputs: TemplateInput[], values: Record<string, string>): string[] {
  return inputs.filter((i) => i.required && !(values[i.label] ?? "").trim()).map((i) => i.label);
}

export function normalizeValues(raw: unknown, inputs: TemplateInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  const allowed = new Set(inputs.map((i) => i.label));
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) continue; // 定義にない入力は捨てる
    if (typeof v === "string") out[k] = v.trim().slice(0, LIMITS.valueLen);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

// ---------- ゴールの木 → 型のタスク ----------
type GoalRow = { id: string; parent_goal_id: string | null; name: string; completion_criteria: string | null; order_idx: number; status: string };

// goalId の子孫 (archived 以外) を order_idx 順に取り、木に組む。
// 再帰 CTE は queries.ts の archiveGoal と同じ形 (CROSS JOIN で結合順を固定。本番で結合順が暴れて 15 秒かかった前例がある)。
export async function snapshotGoalTree(db: D1Database, wsId: string, goalId: string): Promise<TemplateTask[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT id, 0 FROM projects WHERE id = ? AND workspace_id = ?
         UNION
         SELECT c.id, sub.depth + 1 FROM sub CROSS JOIN projects c ON c.parent_goal_id = sub.id
          WHERE c.workspace_id = ? AND c.status != 'archived' AND sub.depth < ?
       )
       SELECT p.id, p.parent_goal_id, p.name, p.completion_criteria, p.order_idx, p.status
         FROM sub JOIN projects p ON p.id = sub.id
        WHERE p.id != ?
        ORDER BY p.order_idx, p.created_at`
    )
    .bind(goalId, wsId, wsId, LIMITS.depth, goalId)
    .all<GoalRow>();
  const rows = results ?? [];
  const byParent = new Map<string, GoalRow[]>();
  for (const r of rows) {
    const key = r.parent_goal_id ?? "";
    const b = byParent.get(key);
    if (b) b.push(r);
    else byParent.set(key, [r]);
  }
  const build = (parentId: string): TemplateTask[] =>
    (byParent.get(parentId) ?? []).map((r) => {
      const children = build(r.id);
      return {
        text: r.name,
        ...(r.completion_criteria ? { completion_criteria: r.completion_criteria } : {}),
        ...(children.length ? { children } : {}),
      };
    });
  return normalizeTasks(build(goalId));
}

// ---------- 型 → 新しいゴールの木 ----------
export type ApplyOptions = {
  parentId: string;
  memberId: string;        // 担当にする members.id
  memberName: string;
  values: Record<string, string>;
  creatorUserId: string | null;
  creatorName: string | null;
  deadline?: string | null; // YYYY-MM-DD
  now: string;              // ISO
};

type Stmt = { sql: string; args: unknown[] };

const INSERT_GOAL =
  `INSERT INTO projects (id, name, parent_goal_id, order_idx, created_at, status, workspace_id,
                         completion_criteria, current_state, criteria_updated_at, state_updated_at,
                         created_by, deadline, template_id)
   VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`;

export function buildCurrentState(tpl: Template, o: ApplyOptions): string {
  const day = o.now.slice(0, 10);
  const lines = [`${day}時点。型「${substitute(tpl.name, o.values) || tpl.name}」から作成${o.creatorName ? ` (作成: ${o.creatorName})` : ""}。`];
  const filled = tpl.inputs.filter((i) => (o.values[i.label] ?? "").trim());
  if (filled.length) {
    lines.push("", "入力:");
    for (const i of filled) lines.push(`- ${i.label}: ${o.values[i.label]}`);
  }
  lines.push("", `ボール: ${o.memberName}`, "残り: 全タスク未着手");
  return lines.join("\n");
}

// 1 回の db.batch で root + 子タスク + リソース + 担当を入れる。
// D1 は 1 文あたりの bind 上限 (100) と、batch 全体のサイズ制限があるので 40 文ずつに分けて流す。
export async function applyTemplate(db: D1Database, wsId: string, tpl: Template, o: ApplyOptions): Promise<{ rootId: string; created: number }> {
  const missing = missingRequiredInputs(tpl.inputs, o.values);
  if (missing.length) throw new Error(`必須の入力が空です: ${missing.join("、")}`);
  const parent = await db.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(o.parentId, wsId).first<{ id: string }>();
  if (!parent) throw new Error(`goal not found: ${o.parentId}`);
  const member = await db.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ?").bind(o.memberId, wsId).first<{ id: string }>();
  if (!member) throw new Error(`member not found: ${o.memberId}`);
  const max = await db
    .prepare("SELECT COALESCE(MAX(order_idx), -1) AS m FROM projects WHERE workspace_id = ? AND parent_goal_id = ?")
    .bind(wsId, o.parentId)
    .first<{ m: number }>();

  const stmts: Stmt[] = [];
  const rootId = crypto.randomUUID();
  const rootName = substitute(tpl.name, o.values).trim() || tpl.name;
  const rootCriteria = substitute(tpl.completion_criteria, o.values).trim() || null;
  const deadline = o.deadline && /^\d{4}-\d{2}-\d{2}$/.test(o.deadline) ? o.deadline : null;
  stmts.push({
    sql: INSERT_GOAL,
    args: [rootId, rootName, o.parentId, (max?.m ?? -1) + 1, o.now, wsId, rootCriteria, buildCurrentState(tpl, o),
      rootCriteria ? o.now : null, o.now, o.creatorUserId, deadline, tpl.id],
  });
  let created = 1;
  const walk = (list: TemplateTask[], parentId: string) => {
    list.forEach((t, i) => {
      const id = crypto.randomUUID();
      const cc = substitute(t.completion_criteria, o.values).trim() || null;
      stmts.push({
        sql: INSERT_GOAL,
        args: [id, substitute(t.text, o.values).trim() || t.text, parentId, i, o.now, wsId, cc, null, cc ? o.now : null, null, o.creatorUserId, null, tpl.id],
      });
      created++;
      if (t.children) walk(t.children, id);
    });
  };
  walk(tpl.tasks, rootId);
  for (const r of tpl.resources) {
    stmts.push({
      sql: "INSERT INTO resources (id, goal_id, name, kind, content, url, workspace_id) VALUES (?, ?, ?, 'link', ?, ?, ?)",
      args: [crypto.randomUUID(), rootId, r.name, `${r.kind}${r.why ? `: ${r.why}` : ""}`, r.url, wsId],
    });
  }
  stmts.push({ sql: "INSERT OR IGNORE INTO goal_members (goal_id, member_id, can_edit) VALUES (?, ?, 1)", args: [rootId, o.memberId] });
  // 親は一番下ではなくなるので進行中を外す (queries.ts clearStartedOnParent と同じ)
  stmts.push({ sql: "UPDATE projects SET started_at = NULL, started_by = NULL, started_by_name = NULL, started_via = NULL WHERE id = ? AND workspace_id = ?", args: [o.parentId, wsId] });

  for (let i = 0; i < stmts.length; i += 40) {
    const chunk = stmts.slice(i, i + 40);
    await db.batch(chunk.map((s) => db.prepare(s.sql).bind(...s.args)));
  }
  return { rootId, created };
}

// ---------- 外 (GitHub) への書き出し ----------
// 型 1 本 = Markdown 1 枚。型を直すたびに書き出し、こつこつが止まってもここから資料と注意点に辿れるようにする
// (黒崎判断 2026-10-15: 置き場所は GitHub)。
// 書くのは基本 AI の側 (本人の GitHub ログインで書く)。サーバーにはトークンを置かない (黒崎 10/15「トークンではなくリンクで」)。
// KATA_GITHUB_REPO だけ設定すると、置き場所のリンクが決まり、AI に「ここへ書け」が渡る。
// KATA_GITHUB_TOKEN も入れた環境だけ、サーバーが自分で書く。どちらも無い環境 (公開版・Docker 版の既定) では何もしない。
export type KataExportTarget = { repo: string; branch: string; dir: string };
export type KataExportConfig = KataExportTarget & { token: string };

export function kataExportTarget(env: Record<string, unknown>): KataExportTarget | null {
  const repo = typeof env.KATA_GITHUB_REPO === "string" ? env.KATA_GITHUB_REPO.trim() : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const branch = typeof env.KATA_GITHUB_BRANCH === "string" && env.KATA_GITHUB_BRANCH.trim() ? env.KATA_GITHUB_BRANCH.trim() : "main";
  return { repo, branch, dir: "型" };
}

export function kataExportConfig(env: Record<string, unknown>): KataExportConfig | null {
  const target = kataExportTarget(env);
  const token = typeof env.KATA_GITHUB_TOKEN === "string" ? env.KATA_GITHUB_TOKEN.trim() : "";
  return target && token ? { ...target, token } : null;
}

/** 置き場所のリンク (GitHub で開ける URL)。 */
export function kataExportUrl(target: KataExportTarget, path: string): string {
  return `https://github.com/${target.repo}/blob/${target.branch}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** 外の Markdown がこつこつの型より古いか (一度も書いていない・書いた後に型を直した)。 */
export function kataExportStale(t: Pick<Template, "updated_at" | "exported_at">): boolean {
  return !t.exported_at || t.exported_at < t.updated_at;
}

/** 型と結んだ前例・履歴から、書き出す Markdown を作る (AI に渡す用とサーバーで書く用で共通)。 */
export async function buildKataMarkdown(db: D1Database, wsId: string, t: Template, now: string): Promise<string> {
  const { results } = await db.prepare(
    "SELECT title, author_name AS by, steps, pitfalls FROM playbooks WHERE workspace_id = ? AND template_id = ? ORDER BY updated_at DESC, id LIMIT 10"
  ).bind(wsId, t.id).all<ExportPrecedent>();
  const revisions = await listTemplateRevisions(db, wsId, t.id, 20);
  return templateMarkdown(t, { precedents: results ?? [], revisions, now });
}

type ExportPrecedent = { title: string; by?: string | null; steps: string; pitfalls?: string | null };
type ExportRevision = { created_at: string; actor_name: string | null; reason: string | null; changes: string[] };

export function templateMarkdown(t: Template, extra: { precedents: ExportPrecedent[]; revisions: ExportRevision[]; now: string }): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const L: string[] = [`# ${t.name}`, ""];
  L.push(`こつこつの型 (id: ${t.id})。最後に書き出した日時: ${extra.now.slice(0, 16).replace("T", " ")} UTC`, "");
  L.push("こつこつが使えないときは、この文書の資料と注意点を見て、下のタスクを手で起こして進める。", "");
  if (t.purpose) L.push("## 何のための型か", "", t.purpose, "");
  if (t.completion_criteria) L.push("## 完了の基準", "", t.completion_criteria, "");
  L.push("## 資料", "");
  if (t.resources.length) {
    L.push("| 種類 | 名前 | 何のために見るか |", "|---|---|---|");
    for (const r of t.resources) L.push(`| ${r.kind} | [${esc(r.name).replace(/[[\]]/g, "")}](${r.url.replace(/\|/g, "%7C").replace(/\)/g, "%29").replace(/ /g, "%20")}) | ${esc(r.why ?? "")} |`);
  } else L.push("(まだ無い)");
  L.push("", "## 注意点", "");
  if (t.cautions.length) for (const c of t.cautions) L.push(`- ${c.text}${c.added_at ? ` (${c.added_at.slice(0, 10)}${c.added_by ? ` ${c.added_by}` : ""})` : ""}`);
  else L.push("(まだ無い)");
  if (t.inputs.length) {
    L.push("", "## 振るときに入れる値", "");
    for (const i of t.inputs) L.push(`- ${i.label}${i.required ? " (必須)" : ""}${i.hint ? `: ${i.hint}` : ""}`);
  }
  L.push("", "## タスク", "");
  if (t.tasks.length) {
    const walk = (l: TemplateTask[], d: number) => {
      for (const x of l) {
        L.push(`${"  ".repeat(d)}- [ ] ${x.text}${x.completion_criteria ? ` — 完了の基準: ${x.completion_criteria.replace(/\n/g, " / ")}` : ""}`);
        if (x.children) walk(x.children, d + 1);
      }
    };
    walk(t.tasks, 0);
  } else L.push("(まだ無い)");
  if (extra.precedents.length) {
    L.push("", "## 前例 (以前のやり方)", "");
    for (const p of extra.precedents) {
      L.push(`### ${p.title}${p.by ? ` (${p.by})` : ""}`, "", p.steps, "");
      if (p.pitfalls) L.push(`気をつけたこと: ${p.pitfalls}`, "");
    }
  }
  if (extra.revisions.length) {
    L.push("", "## 直した履歴 (新しい順)", "");
    for (const r of extra.revisions) {
      L.push(`- ${r.created_at.slice(0, 10)} ${r.actor_name ?? ""}: ${r.reason ?? ""}${r.changes.length ? ` (${r.changes.join(" / ")})` : ""}`);
    }
  }
  return L.join("\n") + "\n";
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 書き出す先のパス。1 回書き出した型は同じパスに書く (名前を変えてもファイルが増えないように)
export function kataExportPath(cfg: KataExportTarget, t: Pick<Template, "id" | "name" | "export_url">): string {
  const prefix = `https://github.com/${cfg.repo}/blob/${cfg.branch}/`;
  if (t.export_url?.startsWith(prefix)) return decodeURIComponent(t.export_url.slice(prefix.length));
  const safe = t.name.replace(/[\\/:*?"<>|#%{}\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "型";
  return `${cfg.dir}/${safe}_${t.id.slice(0, 8)}.md`;
}

/** GitHub の Contents API で 1 ファイルを作成・更新し、開ける URL を返す。失敗は投げる (呼び手が利用者に見せる)。 */
export async function pushKataMarkdown(cfg: KataExportConfig, path: string, content: string, message: string): Promise<string> {
  const api = `https://api.github.com/repos/${cfg.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "kotsukotsu-kata-export",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const cur = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers });
  let sha: string | undefined;
  if (cur.ok) sha = ((await cur.json()) as { sha?: string }).sha;
  else if (cur.status !== 404) throw new Error(`GitHub から今のファイルを読めませんでした (${cur.status})`);
  const put = await fetch(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: utf8ToBase64(content), branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  if (!put.ok) throw new Error(`GitHub に書き出せませんでした (${put.status}): ${(await put.text()).slice(0, 200)}`);
  return kataExportUrl(cfg, path);
}

/**
 * 型を Markdown にして書き出し、templates.export_url / exported_at を更新する。
 * 書き出し先が設定されていなければ { skipped: true }。失敗は { error } で返す (型の保存は済んでいるので巻き戻さない)。
 */
export async function exportTemplate(
  db: D1Database, wsId: string, templateId: string, cfg: KataExportConfig | null, now: string
): Promise<{ skipped?: true; url?: string; error?: string }> {
  if (!cfg) return { skipped: true };
  try {
    const row = await db.prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ?").bind(templateId, wsId).first<TemplateRow>();
    if (!row) return { error: "型が見つかりません" };
    const t = parseTemplateRow(row);
    const md = await buildKataMarkdown(db, wsId, t, now);
    const url = await pushKataMarkdown(cfg, kataExportPath(cfg, t), md, `型「${t.name}」を書き出す`);
    await db.prepare("UPDATE templates SET export_url = ?, exported_at = ? WHERE id = ? AND workspace_id = ?").bind(url, now, templateId, wsId).run();
    return { url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
