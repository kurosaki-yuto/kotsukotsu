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
// url は外のリンク (https://…) か、こつこつに上げたファイル (r2:<ワークスペース>/templates/<型id>/<名前>)。size はファイルのときだけ。
export type TemplateResource = { kind: ResourceKind; name: string; url: string; why?: string; size?: number };

export const isFileUrl = (url: string) => url.startsWith("r2:");
/** 型のファイルを置くキーの接頭辞。ここ以外の r2: は型に入れない (他のゴールのファイルを型経由で配らせない)。 */
export const templateFilePrefix = (wsId: string, templateId: string) => `r2:${wsId}/templates/${templateId}/`;
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
  // 0030: 見える範囲・自分だけのメモ・機能・繰り返し
  visibility?: string | null;
  private_note?: string | null;
  function?: string | null;
  schedule?: string | null;
  schedule_target?: string | null;
  last_run_key?: string | null;
  last_run_at?: string | null;
  last_run_goal_id?: string | null;
};

export type Template = Omit<TemplateRow, "inputs" | "tasks" | "resources" | "cautions" | "embedding" | "embedding_model" | "visibility" | "function" | "schedule" | "schedule_target"> & {
  inputs: TemplateInput[];
  tasks: TemplateTask[];
  resources: TemplateResource[];
  cautions: TemplateCaution[];
  visibility: TemplateVisibility;
  function: TemplateFunction | null;
  schedule: TemplateSchedule | null;
  schedule_target: TemplateScheduleTarget | null;
};

// ---------- 見える範囲・機能・繰り返し (0030) ----------
// 見える範囲: private = 作った人と管理者 / assigned = 上 + その型から作ったゴールの担当者 / workspace = 全員
export const TEMPLATE_VISIBILITIES = ["private", "assigned", "workspace"] as const;
export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];
export const VISIBILITY_LABEL: Record<TemplateVisibility, string> = { private: "自分だけ", assigned: "振った相手も", workspace: "全員" };
/** 新しく作る型の見える範囲 (黒崎判断 2026-11-02: 振った相手まで)。 */
export const DEFAULT_VISIBILITY: TemplateVisibility = "assigned";
// 機能: もちもつのフォルダ 00〜50 と同じ区分。型の一覧をこの順で並べる
export const TEMPLATE_FUNCTIONS = ["経営", "財務", "法務", "集客", "営業", "CS", "その他"] as const;
export type TemplateFunction = (typeof TEMPLATE_FUNCTIONS)[number];
// 繰り返し。time はワークスペースのタイムゾーンの HH:MM。weekday は 0=日〜6=土、day は 1〜31 (月末を越える日はその月の最終日)
export type TemplateSchedule = { freq: "daily" | "weekly" | "monthly"; time: string; weekday?: number; day?: number };
// 繰り返しで振る先。deadline_days = 振った日から何日後を期限にするか
export type TemplateScheduleTarget = { parent_id: string; member_id: string; values: Record<string, string>; deadline_days?: number };
export const LIMIT_PRIVATE_NOTE = 4000;

export function normalizeVisibility(v: unknown, fallback: TemplateVisibility = "workspace"): TemplateVisibility {
  return (TEMPLATE_VISIBILITIES as readonly string[]).includes(v as string) ? (v as TemplateVisibility) : fallback;
}
export function normalizeFunction(v: unknown): TemplateFunction | null {
  const s = typeof v === "string" ? v.trim() : "";
  return (TEMPLATE_FUNCTIONS as readonly string[]).includes(s) ? (s as TemplateFunction) : null;
}
export function normalizeSchedule(raw: unknown): TemplateSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const freq = o.freq;
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") return null;
  const m = typeof o.time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(o.time.trim()) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const time = `${m[1].padStart(2, "0")}:${m[2]}`;
  if (freq === "weekly") {
    const w = Number(o.weekday);
    return Number.isInteger(w) && w >= 0 && w <= 6 ? { freq, time, weekday: w } : null;
  }
  if (freq === "monthly") {
    const d = Number(o.day);
    return Number.isInteger(d) && d >= 1 && d <= 31 ? { freq, time, day: d } : null;
  }
  return { freq, time };
}
export function normalizeScheduleTarget(raw: unknown): TemplateScheduleTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const parent_id = typeof o.parent_id === "string" ? o.parent_id.trim() : "";
  const member_id = typeof o.member_id === "string" ? o.member_id.trim() : "";
  if (!parent_id || !member_id) return null;
  const values: Record<string, string> = {};
  if (o.values && typeof o.values === "object") {
    for (const [k, v] of Object.entries(o.values as Record<string, unknown>)) {
      if (typeof v === "string" && k.length <= LIMITS.inputLabel) values[k] = v.trim().slice(0, LIMITS.valueLen);
    }
  }
  const dd = Number(o.deadline_days);
  return { parent_id, member_id, values, ...(Number.isInteger(dd) && dd >= 0 && dd <= 365 ? { deadline_days: dd } : {}) };
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
/** 「毎週月曜 9:00」のような 1 行。 */
export function describeSchedule(s: TemplateSchedule | null): string {
  if (!s) return "繰り返さない";
  const t = s.time.replace(/^0/, "");
  if (s.freq === "daily") return `毎日 ${t}`;
  if (s.freq === "weekly") return `毎週${WEEKDAYS[s.weekday ?? 1]}曜 ${t}`;
  return `毎月${s.day}日 ${t}`;
}

// 型を読む人。workspace キー (人に結びつかない接続) と管理者は全部読める
export type TemplateViewer = { userId: string | null; email: string | null; admin: boolean };

/** 型を直せる (= 自分だけのメモ・繰り返しの設定まで読める) のは管理者と作った本人。 */
export function canManageTemplate(v: TemplateViewer, t: { created_by: string | null }): boolean {
  return v.admin || (!!t.created_by && !!v.userId && t.created_by === v.userId);
}

/**
 * 型 (別名 alias) を viewer が読めるかの SQL 条件。続けて templateReadableBinds(viewer) を bind する。
 * assigned は「その型から作ったゴール (配下のタスクも template_id を持つ) に、メールが一致する担当がいる」で見る。
 * 担当は今の状態から毎回計算する (読めるかは今の権限なので、スナップショットしない)。
 */
export function templateReadableSql(alias = "t"): string {
  return `(? = 1 OR ${alias}.created_by = ? OR COALESCE(${alias}.visibility, 'workspace') = 'workspace'
     OR (${alias}.visibility = 'assigned' AND EXISTS (
       SELECT 1 FROM projects rp
         JOIN goal_members rgm ON rgm.goal_id = rp.id
         JOIN members rm ON rm.id = rgm.member_id
        WHERE rp.template_id = ${alias}.id AND rp.workspace_id = ${alias}.workspace_id AND rp.status != 'archived'
          AND rm.workspace_id = ${alias}.workspace_id AND rm.email IS NOT NULL AND lower(rm.email) = lower(?))))`;
}
export function templateReadableBinds(v: TemplateViewer): unknown[] {
  return [v.admin ? 1 : 0, v.userId ?? "", v.email ?? ""];
}

/** 型を読めるか (1 件)。 */
export async function canReadTemplate(db: D1Database, wsId: string, templateId: string, v: TemplateViewer): Promise<boolean> {
  const r = await db.prepare(`SELECT 1 AS ok FROM templates t WHERE t.id = ? AND t.workspace_id = ? AND ${templateReadableSql("t")}`)
    .bind(templateId, wsId, ...templateReadableBinds(v)).first<{ ok: number }>();
  return !!r;
}

/** 直せない人に返すときは、自分だけのメモと振る先を外す。 */
export function redactTemplate<T extends Pick<Template, "created_by" | "private_note" | "schedule_target">>(t: T, v: TemplateViewer): T & { can_manage: boolean } {
  const can = canManageTemplate(v, t);
  return can ? { ...t, can_manage: true } : { ...t, private_note: null, schedule_target: null, can_manage: false };
}

// 見える範囲・メモ・機能・繰り返しを直す。中身 (履歴に残す範囲) とは別に保存する。
export type TemplateSettingsPatch = { visibility?: unknown; private_note?: unknown; function?: unknown; schedule?: unknown; schedule_target?: unknown };
export async function saveTemplateSettings(db: D1Database, wsId: string, templateId: string, p: TemplateSettingsPatch, now: string): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (p.visibility !== undefined) { sets.push("visibility = ?"); args.push(normalizeVisibility(p.visibility, DEFAULT_VISIBILITY)); }
  if (p.private_note !== undefined) { sets.push("private_note = ?"); args.push(typeof p.private_note === "string" ? p.private_note.trim().slice(0, LIMIT_PRIVATE_NOTE) || null : null); }
  if (p.function !== undefined) { sets.push("function = ?"); args.push(normalizeFunction(p.function)); }
  if (p.schedule !== undefined) { const s = normalizeSchedule(p.schedule); sets.push("schedule = ?"); args.push(s ? JSON.stringify(s) : null); }
  if (p.schedule_target !== undefined) { const s = normalizeScheduleTarget(p.schedule_target); sets.push("schedule_target = ?"); args.push(s ? JSON.stringify(s) : null); }
  if (!sets.length) return false;
  await db.prepare(`UPDATE templates SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND workspace_id = ?`).bind(...args, now, templateId, wsId).run();
  return true;
}

/**
 * 繰り返しの設定を保存する前の確かめ。直せないものは日本語の理由を返す (null なら通す)。
 * 振る先の親ゴール・担当・必須の入力が揃っていないと、時刻になっても振れずに黙って止まるため。
 */
export async function checkScheduleSettings(
  db: D1Database, wsId: string, t: Pick<Template, "inputs">, schedule: unknown, target: unknown
): Promise<string | null> {
  if (schedule === null || schedule === undefined) return null;
  const s = normalizeSchedule(schedule);
  if (!s) return "繰り返しの書き方が正しくありません (freq: daily/weekly/monthly、time: HH:MM、weekly は weekday 0〜6、monthly は day 1〜31)";
  const g = normalizeScheduleTarget(target);
  if (!g) return "繰り返すときは、振る先 (置き場所のゴールと担当) が要ります";
  const parent = await db.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND status != 'archived'").bind(g.parent_id, wsId).first();
  if (!parent) return "振る先の置き場所 (ゴール) が見つかりません";
  const member = await db.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ?").bind(g.member_id, wsId).first();
  if (!member) return "振る先の担当が見つかりません";
  const missing = missingRequiredInputs(t.inputs, g.values);
  if (missing.length) return `繰り返しで振るときの入力が空です: ${missing.join("、")}`;
  return null;
}

/**
 * 今がこの繰り返しの回に当たるなら、その回の印 ("YYYY-MM-DDTHH:MM"、ワークスペースの時刻) を返す。
 * その日の時刻を過ぎていれば当日中は同じ印を返す (cron が遅れても、その日のうちに一度だけ振る)。
 */
export function scheduleOccurrence(s: TemplateSchedule, now: Date, timezone: string): string | null {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
        .formatToParts(now).map((p) => [p.type, p.value])
    );
  } catch {
    return timezone === "Asia/Tokyo" ? null : scheduleOccurrence(s, now, "Asia/Tokyo");
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hm = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  if (hm < s.time) return null;
  if (s.freq === "weekly") {
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    if (wd !== s.weekday) return null;
  }
  if (s.freq === "monthly") {
    const y = Number(parts.year), mo = Number(parts.month), d = Number(parts.day);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d !== Math.min(s.day ?? 1, last)) return null;
  }
  return `${date}T${s.time}`;
}

/**
 * AI の定期実行 (クラウドのルーチン) を組むための指示。繰り返しを入れた型に付けて返す。
 * こつこつは時刻に今回分のゴールを作るだけで、手を動かすのは AI の定期実行 (黒崎判断 2026-11-02)。
 */
export function routineSetupText(t: Pick<Template, "id" | "name" | "schedule">): string | null {
  if (!t.schedule) return null;
  const [h, m] = t.schedule.time.split(":").map(Number);
  const after = `${String((h + (m + 15 >= 60 ? 1 : 0)) % 24).padStart(2, "0")}:${String((m + 15) % 60).padStart(2, "0")}`;
  const when = describeSchedule({ ...t.schedule, time: after });
  return [
    `型「${t.name}」は ${describeSchedule(t.schedule)} に、こつこつが今回分のゴールを作って担当の今日に入れる。`,
    `手順を最後まで回すのは AI の定期実行。まだ組んでいなければ、${when} (こつこつが作った15分後) に動くクラウドの定期実行を1本組み、次の指示を入れる:`,
    "",
    `「こつこつの list_my_tasks で、型「${t.name}」(template_id: ${t.id}) から今日作られた未完了のゴールを探す。無ければ何もせず終える。`,
    "あれば get_goal でその型 (kata) と完了の基準を読み、上のタスクから順に start_task → 手順 → 完了基準照合 → complete_subtask で最後まで進める。",
    "外向きの送信・支払い・契約・公開は実行せず、下書きを作って現状に「承認待ち」と書いて止まる。終わったら send_chat でそのゴールに結果を残す。」",
  ].join("\n");
}

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
    // http(s) のリンクか、こつこつに上げたファイル (r2:) だけ。javascript: 等は入れない
    const file = /^r2:[^\s/]+\/templates\/[^\s/]+\/[^\s]+$/.test(url);
    if (!url || (!file && !/^https?:\/\//i.test(url))) continue;
    const name = str((it as { name?: unknown }).name, LIMITS.resourceName) || (file ? url.split("/").pop()!.replace(/^[0-9a-f-]{36}-/, "") : url);
    const k = str((it as { kind?: unknown }).kind, 10);
    const kind: ResourceKind = (RESOURCE_KINDS as readonly string[]).includes(k) ? (k as ResourceKind) : file ? "実物" : "情報源";
    const why = str((it as { why?: unknown }).why, LIMITS.resourceWhy).replace(/\s*\n\s*/g, " ");
    const size = file ? Number((it as { size?: unknown }).size) : NaN;
    out.push({ kind, name, url, ...(why ? { why } : {}), ...(Number.isFinite(size) && size > 0 ? { size } : {}) });
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
  const obj = (s: string | null | undefined): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    ...rest,
    inputs: normalizeInputs(safe(row.inputs)),
    tasks: normalizeTasks(safe(row.tasks)),
    resources: normalizeResources(safe(row.resources)),
    cautions: normalizeCautions(safe(row.cautions)),
    visibility: normalizeVisibility(row.visibility),
    private_note: row.private_note ?? null,
    function: normalizeFunction(row.function),
    schedule: normalizeSchedule(obj(row.schedule)),
    schedule_target: normalizeScheduleTarget(obj(row.schedule_target)),
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
  const prefix = templateFilePrefix(wsId, t.id);
  // 送り直しで大きさが抜けたファイルは、前の大きさを引き継ぐ
  const sizeOf = new Map(before.resources.filter((r) => r.size).map((r) => [r.url, r.size!]));
  after.resources = after.resources
    .filter((r) => !isFileUrl(r.url) || r.url.startsWith(prefix))
    .map((r) => (isFileUrl(r.url) && !r.size && sizeOf.has(r.url) ? { ...r, size: sizeOf.get(r.url) } : r));
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
      // 型のファイルはコピーせず同じキーを指す (ゴール側で消しても、削除はゴールの接頭辞にしか効かないので型のファイルは残る)
      sql: "INSERT INTO resources (id, goal_id, name, kind, content, url, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [crypto.randomUUID(), rootId, r.name, isFileUrl(r.url) ? "file" : "link", `${r.kind}${r.why ? `: ${r.why}` : ""}`, r.url, wsId],
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
    for (const r of t.resources) {
      const label = esc(r.name).replace(/[[\]]/g, "");
      const cell = isFileUrl(r.url)
        ? `${label} (こつこつ内のファイル${r.size ? `、${Math.max(1, Math.round(r.size / 1024))}KB` : ""})`
        : `[${label}](${r.url.replace(/\|/g, "%7C").replace(/\)/g, "%29").replace(/ /g, "%20")})`;
      L.push(`| ${r.kind} | ${cell} | ${esc(r.why ?? "")} |`);
    }
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
