// 型 (テンプレート) の中身と、「ゴールの木 → 型」「型 → 新しいゴールの木」の変換。
// Web の API ルートと mcp-worker の両方から使うので、ここは純粋な関数だけ。
// `server-only` や platformEnv は import しない (mcp-worker は Next の外で束ねる)。
// D1 への読み書きは引数の db (D1Database) を通す。

export type TemplateInput = { label: string; hint?: string; required?: boolean };
export type TemplateTask = { text: string; completion_criteria?: string | null; children?: TemplateTask[] };
export type TemplateResource = { name: string; url: string };

export type TemplateRow = {
  id: string;
  workspace_id: string;
  name: string;
  purpose: string | null;
  completion_criteria: string | null;
  inputs: string;
  tasks: string;
  resources: string;
  source_goal_id: string | null;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type Template = Omit<TemplateRow, "inputs" | "tasks" | "resources"> & {
  inputs: TemplateInput[];
  tasks: TemplateTask[];
  resources: TemplateResource[];
};

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
    out.push({ name, url });
    if (out.length >= LIMITS.resources) break;
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
  const safe = (s: string): unknown => { try { return JSON.parse(s); } catch { return []; } };
  return {
    ...row,
    inputs: normalizeInputs(safe(row.inputs)),
    tasks: normalizeTasks(safe(row.tasks)),
    resources: normalizeResources(safe(row.resources)),
  };
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
      sql: "INSERT INTO resources (id, goal_id, name, kind, content, url, workspace_id) VALUES (?, ?, ?, 'link', NULL, ?, ?)",
      args: [crypto.randomUUID(), rootId, r.name, r.url, wsId],
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
