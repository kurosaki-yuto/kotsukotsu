import { json, bad, db, nowIso } from "../../../lib/server/db";
import { requireWorkspace, viewRoots } from "../../../lib/server/workspace";
import { getTemplate, updateTemplate, archiveTemplate, listGoalsFromTemplate, listGoals, listRevisions, templateViewer, canEditGoal } from "../../../lib/server/queries";
import {
  normalizeResources, resourcesMissingWhy, canReadTemplate, canManageTemplate, redactTemplate, routineSetupText,
  saveTemplateSettings, checkScheduleSettings, normalizeScheduleTarget, type TemplateSettingsPatch,
} from "../../../lib/server/templateCore";

export async function GET(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const viewer = templateViewer(ctx);
  const t = await getTemplate(id, ctx.workspaceId);
  // 見える範囲の外の型は「無い」と同じに返す (あることも知らせない)
  if (!t || t.archived_at || !(await canReadTemplate(db(), ctx.workspaceId, id, viewer))) return json({ error: "not found" }, { status: 404 });
  const [allGoals, revisions, roots] = await Promise.all([listGoalsFromTemplate(id, ctx.workspaceId), listRevisions(id, ctx.workspaceId), viewRoots(ctx)]);
  // この型から作られたゴールも、見える範囲のものだけ (2026-11-05 監査: 範囲外の案件名と担当が見えていた)
  let goals = allGoals;
  if (roots !== null) {
    const visible = new Set(((await listGoals(ctx.workspaceId, roots)) as { id: string }[]).map((g) => g.id));
    goals = allGoals.filter((g) => visible.has(g.id));
  }
  const view = redactTemplate(t, viewer);
  return json({ ...view, goals, revisions, routine_setup: view.can_manage ? routineSetupText(t) : null });
}

const PATCH_KEYS = new Set(["name", "purpose", "completion_criteria", "inputs", "tasks", "resources", "cautions"]);
const SETTING_KEYS = new Set(["visibility", "private_note", "function", "schedule", "schedule_target"]);
export async function PATCH(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const viewer = templateViewer(ctx);
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t || t.archived_at || !(await canReadTemplate(db(), ctx.workspaceId, id, viewer))) return json({ error: "not found" }, { status: 404 });
  // 型を直せるのは管理者と作った本人
  if (!canManageTemplate(viewer, t)) return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return bad("invalid body", 400);
  const patch: Record<string, unknown> = {};
  const settings: TemplateSettingsPatch = {};
  for (const k of Object.keys(body)) {
    if (PATCH_KEYS.has(k)) patch[k] = body[k];
    if (SETTING_KEYS.has(k)) (settings as Record<string, unknown>)[k] = body[k];
  }
  if ("resources" in patch) {
    const noWhy = resourcesMissingWhy(normalizeResources(patch.resources));
    if (noWhy.length) return bad(`資料に「何のために見るか」を書いてください: ${noWhy.join("、")}`, 400);
  }
  // 繰り返しを入れるときは、振る先が揃っていて、置き場所のゴールをこの人が編集できることを先に確かめる
  if (settings.schedule !== undefined || settings.schedule_target !== undefined) {
    const schedule = settings.schedule !== undefined ? settings.schedule : t.schedule;
    const target = settings.schedule_target !== undefined ? settings.schedule_target : t.schedule_target;
    const why = await checkScheduleSettings(db(), ctx.workspaceId, t, schedule, target);
    if (why) return bad(why, 400);
    const g = normalizeScheduleTarget(target);
    if (schedule && g && !(await canEditGoal({ id: ctx.user.id, email: ctx.user.email, role: ctx.role }, g.parent_id, ctx.workspaceId))) {
      return bad("振る先の置き場所 (ゴール) を編集できる人だけが繰り返しを入れられます", 403);
    }
  }
  const exportError = await updateTemplate(t, patch, ctx.workspaceId, ctx.user.name || ctx.user.email);
  await saveTemplateSettings(db(), ctx.workspaceId, id, settings, nowIso());
  const next = (await getTemplate(id, ctx.workspaceId))!;
  return json({ ...redactTemplate(next, viewer), routine_setup: routineSetupText(next), ...(exportError ? { export_error: exportError } : {}) });
}

export async function DELETE(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t) return json({ error: "not found" }, { status: 404 });
  if (!canManageTemplate(templateViewer(ctx), t)) return json({ error: "forbidden" }, { status: 403 });
  await archiveTemplate(id, ctx.workspaceId);
  return json({ ok: true });
}
