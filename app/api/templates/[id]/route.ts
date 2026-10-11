import { json, bad } from "../../../lib/server/db";
import { requireWorkspace } from "../../../lib/server/workspace";
import { getTemplate, updateTemplate, archiveTemplate, listGoalsFromTemplate } from "../../../lib/server/queries";

// 型を直せるのは管理者と作った本人
function canManage(ctx: { user: { id: string }; role: string }, t: { created_by: string | null }): boolean {
  return ctx.role === "admin" || (!!t.created_by && t.created_by === ctx.user.id);
}

export async function GET(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t || t.archived_at) return json({ error: "not found" }, { status: 404 });
  const goals = await listGoalsFromTemplate(id, ctx.workspaceId);
  return json({ ...t, goals, can_manage: canManage(ctx, t) });
}

const PATCH_KEYS = new Set(["name", "purpose", "completion_criteria", "inputs", "tasks", "resources"]);
export async function PATCH(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t || t.archived_at) return json({ error: "not found" }, { status: 404 });
  if (!canManage(ctx, t)) return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return bad("invalid body", 400);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (PATCH_KEYS.has(k)) patch[k] = body[k];
  await updateTemplate(id, patch, ctx.workspaceId);
  return json(await getTemplate(id, ctx.workspaceId));
}

export async function DELETE(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t) return json({ error: "not found" }, { status: 404 });
  if (!canManage(ctx, t)) return json({ error: "forbidden" }, { status: 403 });
  await archiveTemplate(id, ctx.workspaceId);
  return json({ ok: true });
}
