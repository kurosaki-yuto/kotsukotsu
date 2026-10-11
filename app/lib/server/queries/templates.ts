import "server-only";
import { listGoalMembersBatch } from "./goalMembers";
import { all, first, run, uid, nowIso } from "../db";
import { parseTemplateRow, normalizeInputs, normalizeTasks, normalizeResources, outlineToTasks, countTasks, LIMITS as TEMPLATE_LIMITS, type Template, type TemplateRow } from "../templateCore";

// ---------------- 型 (テンプレート) ----------------
// 中身の変換・適用は templateCore.ts (mcp-worker と共有)。ここは Web 向けの読み書きだけ。

export type TemplateSummary = Template & { task_count: number; used_count: number };
// tasks はアウトライン文字列 (1 行 1 タスク) でも木の配列でも受ける
const tasksOf = (v: unknown) => (typeof v === "string" ? outlineToTasks(v) : normalizeTasks(v));

export async function listTemplates(wsId: string): Promise<TemplateSummary[]> {
  const rows = await all<TemplateRow & { used_count: number }>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM projects p
              WHERE p.template_id = t.id AND p.workspace_id = t.workspace_id AND p.status != 'archived'
                AND NOT EXISTS (SELECT 1 FROM projects q WHERE q.id = p.parent_goal_id AND q.template_id = t.id)) AS used_count
       FROM templates t
      WHERE t.workspace_id = ? AND t.archived_at IS NULL
      ORDER BY t.updated_at DESC`,
    wsId
  );
  return rows.map((r) => {
    const t = parseTemplateRow(r);
    return { ...t, task_count: countTasks(t.tasks), used_count: r.used_count };
  });
}

export async function getTemplate(id: string, wsId: string): Promise<Template | null> {
  const row = await first<TemplateRow>("SELECT * FROM templates WHERE id = ? AND workspace_id = ?", id, wsId);
  return row ? parseTemplateRow(row) : null;
}

export type TemplateDraft = {
  name: string;
  purpose?: string | null;
  completion_criteria?: string | null;
  inputs?: unknown;
  tasks?: unknown;
  resources?: unknown;
  source_goal_id?: string | null;
};

export async function createTemplate(wsId: string, d: TemplateDraft, user: { id: string; name: string | null; email: string }): Promise<Template> {
  const id = uid();
  const now = nowIso();
  await run(
    `INSERT INTO templates (id, workspace_id, name, purpose, completion_criteria, inputs, tasks, resources, source_goal_id, created_by, author_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, wsId,
    (d.name || "").trim().slice(0, TEMPLATE_LIMITS.name) || "新しい型",
    (d.purpose ?? "").toString().trim().slice(0, TEMPLATE_LIMITS.purpose) || null,
    (d.completion_criteria ?? "").toString().trim().slice(0, TEMPLATE_LIMITS.criteria) || null,
    JSON.stringify(normalizeInputs(d.inputs)),
    JSON.stringify(tasksOf(d.tasks)),
    JSON.stringify(normalizeResources(d.resources)),
    d.source_goal_id ?? null,
    user.id, user.name || user.email, now, now
  );
  return (await getTemplate(id, wsId))!;
}

const TEMPLATE_TEXT_COLS: Record<string, number> = {
  name: TEMPLATE_LIMITS.name,
  purpose: TEMPLATE_LIMITS.purpose,
  completion_criteria: TEMPLATE_LIMITS.criteria,
};
export async function updateTemplate(id: string, patch: Record<string, unknown>, wsId: string): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [col, max] of Object.entries(TEMPLATE_TEXT_COLS)) {
    if (!(col in patch)) continue;
    const v = patch[col];
    const s = typeof v === "string" ? v.trim().slice(0, max) : "";
    if (col === "name" && !s) continue; // 名前は空にしない
    sets.push(`${col} = ?`);
    args.push(s || null);
  }
  if ("inputs" in patch) { sets.push("inputs = ?"); args.push(JSON.stringify(normalizeInputs(patch.inputs))); }
  if ("tasks" in patch) { sets.push("tasks = ?"); args.push(JSON.stringify(tasksOf(patch.tasks))); }
  if ("resources" in patch) { sets.push("resources = ?"); args.push(JSON.stringify(normalizeResources(patch.resources))); }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  args.push(nowIso(), id, wsId);
  await run(`UPDATE templates SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`, ...args);
}

export async function archiveTemplate(id: string, wsId: string): Promise<void> {
  await run("UPDATE templates SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", nowIso(), nowIso(), id, wsId);
}

// 型から作ったゴール (root だけ。子タスクにも template_id は付くが、親が同じ型なら root ではない)
export async function listGoalsFromTemplate(templateId: string, wsId: string) {
  const rows = await all<{ id: string; name: string; status: string; created_at: string; completed_at: string | null; deadline: string | null }>(
    `SELECT p.id, p.name, p.status, p.created_at, p.completed_at, p.deadline
       FROM projects p
      WHERE p.template_id = ? AND p.workspace_id = ? AND p.status != 'archived'
        AND (p.parent_goal_id IS NULL OR p.parent_goal_id NOT IN (SELECT id FROM projects WHERE template_id = ? AND workspace_id = ?))
      ORDER BY p.created_at DESC
      LIMIT 100`,
    templateId, wsId, templateId, wsId
  );
  if (!rows.length) return [];
  const assignees = await listGoalMembersBatch(rows.map((r) => r.id), wsId);
  return rows.map((r) => ({ ...r, assignees: assignees[r.id] ?? [] }));
}
