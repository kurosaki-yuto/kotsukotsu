import "server-only";
import { listGoalMembersBatch } from "./goalMembers";
import { all, first, run, uid, nowIso, db } from "../db";
import { platformEnv } from "../platform";
import { parseTemplateRow, normalizeInputs, normalizeTasks, normalizeResources, normalizeCautions, outlineToTasks, countTasks, saveTemplate, listTemplateRevisions, revertTemplateRevision, exportTemplate, kataExportConfig, LIMITS as TEMPLATE_LIMITS, type Template, type TemplateRow, type TemplatePatch } from "../templateCore";

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
  cautions?: unknown;
  source_goal_id?: string | null;
};

export async function createTemplate(wsId: string, d: TemplateDraft, user: { id: string; name: string | null; email: string }): Promise<Template> {
  const id = uid();
  const now = nowIso();
  await run(
    `INSERT INTO templates (id, workspace_id, name, purpose, completion_criteria, inputs, tasks, resources, cautions, source_goal_id, created_by, author_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, wsId,
    (d.name || "").trim().slice(0, TEMPLATE_LIMITS.name) || "新しい型",
    (d.purpose ?? "").toString().trim().slice(0, TEMPLATE_LIMITS.purpose) || null,
    (d.completion_criteria ?? "").toString().trim().slice(0, TEMPLATE_LIMITS.criteria) || null,
    JSON.stringify(normalizeInputs(d.inputs)),
    JSON.stringify(tasksOf(d.tasks)),
    JSON.stringify(normalizeResources(d.resources)),
    JSON.stringify(normalizeCautions(d.cautions)),
    d.source_goal_id ?? null,
    user.id, user.name || user.email, now, now
  );
  return (await getTemplate(id, wsId))!;
}

// 型を外 (GitHub) に書き出す。設定が無ければ何もしない。失敗は返して画面に出す (保存は済んでいる)
export async function exportKata(templateId: string, wsId: string): Promise<string | null> {
  const env = { ...process.env, ...platformEnv<Record<string, unknown>>() };
  const r = await exportTemplate(db(), wsId, templateId, kataExportConfig(env), nowIso());
  if (r.error) console.log(`[exportKata] ${templateId}: ${r.error}`);
  return r.error ?? null;
}

// 直すたびに履歴を残す (templateCore.saveTemplate。MCP と同じ道を通る)。返り値は書き出しの失敗 (無ければ null)
export async function updateTemplate(t: Template, patch: TemplatePatch, wsId: string, actorName: string | null): Promise<string | null> {
  const r = await saveTemplate(db(), wsId, t, patch, { actorName, actorKind: "human", reason: "画面で直した", now: nowIso() });
  return r.changed ? exportKata(t.id, wsId) : null;
}

export async function listRevisions(templateId: string, wsId: string) {
  return listTemplateRevisions(db(), wsId, templateId);
}

export async function revertRevision(t: Template, revisionId: string, wsId: string, actorName: string | null): Promise<string | null> {
  const r = await revertTemplateRevision(db(), wsId, t, revisionId, { actorName, actorKind: "human", now: nowIso() });
  return r.changed ? exportKata(t.id, wsId) : null;
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

// ---------------- 型に結んだ前例 ----------------
// 前例 (playbooks) を型の「やり方」として結ぶ (黒崎判断 2026-10-15)。候補は題名・語の部分一致で探す。
export type TemplatePlaybook = { id: string; title: string; author_name: string | null; steps: string; pitfalls: string | null; updated_at: string };
const PLAYBOOK_COLS = "id, title, author_name, steps, pitfalls, updated_at";

export async function listTemplatePlaybooks(templateId: string, wsId: string, q: string): Promise<{ linked: TemplatePlaybook[]; candidates: TemplatePlaybook[] }> {
  const linked = await all<TemplatePlaybook>(
    `SELECT ${PLAYBOOK_COLS} FROM playbooks WHERE workspace_id = ? AND template_id = ? ORDER BY updated_at DESC, id LIMIT 50`,
    wsId, templateId
  );
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return { linked, candidates: [] };
  const like = words.map(() => "(title LIKE ? OR coalesce(keywords, '') LIKE ?)").join(" AND ");
  const candidates = await all<TemplatePlaybook>(
    `SELECT ${PLAYBOOK_COLS} FROM playbooks
      WHERE workspace_id = ? AND (template_id IS NULL OR template_id != ?) AND ${like}
      ORDER BY updated_at DESC, id LIMIT 20`,
    wsId, templateId, ...words.flatMap((w) => [`%${w}%`, `%${w}%`])
  );
  return { linked, candidates };
}

export async function linkTemplatePlaybook(templateId: string, playbookId: string, wsId: string, unlink: boolean): Promise<boolean> {
  const r = unlink
    ? await db().prepare("UPDATE playbooks SET template_id = NULL WHERE id = ? AND workspace_id = ? AND template_id = ?").bind(playbookId, wsId, templateId).run()
    : await db().prepare("UPDATE playbooks SET template_id = ? WHERE id = ? AND workspace_id = ?").bind(templateId, playbookId, wsId).run();
  if (r.meta.changes) await exportKata(templateId, wsId);
  return !!r.meta.changes;
}

// このゴールか一番近い祖先が型から作られていれば、その型 (ゴール画面の「この仕事の型」に出す)。
// mcp-worker/src/kata.ts の templateIdForGoal と同じ辿り方。
export async function templateForGoal(goalId: string, wsId: string): Promise<Template | null> {
  const row = await first<{ tpl: string }>(
    `WITH RECURSIVE up(id, parent, tpl, depth) AS (
       SELECT id, parent_goal_id, template_id, 0 FROM projects WHERE id = ? AND workspace_id = ?
       UNION ALL
       SELECT p.id, p.parent_goal_id, p.template_id, up.depth + 1 FROM up CROSS JOIN projects p ON p.id = up.parent
        WHERE p.workspace_id = ? AND up.tpl IS NULL AND up.depth < 20
     )
     SELECT tpl FROM up WHERE tpl IS NOT NULL ORDER BY depth LIMIT 1`,
    goalId, wsId, wsId
  );
  if (!row) return null;
  const t = await getTemplate(row.tpl, wsId);
  return t && !t.archived_at ? t : null;
}
