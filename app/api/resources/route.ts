import { json, bad, first } from "../../lib/server/db";
import { requireWorkspace, goalInScope, requireGoalEdit } from "../../lib/server/workspace";
import { listResources, createResource, updateResource, canEditGoal } from "../../lib/server/queries";

// 画面から作れる種類。file は /api/files (アップロード) だけが作る
const RESOURCE_KINDS = new Set(["note", "link", "doc"]);
// クライアントから来た url。r2: (保存済みファイルのキー) は受けない。https? だけ
function cleanUrl(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 2000) return undefined;
  return /^https?:\/\//i.test(v.trim()) ? v.trim() : undefined;
}
const editor = (ctx: { user: { id: string; email: string }; role: string }) => ({ id: ctx.user.id, email: ctx.user.email, role: ctx.role });

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const goal = new URL(req.url).searchParams.get("goal");
  if (!goal) return bad("goal required", 400);
  if (!(await goalInScope(ctx.workspaceId, goal, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  return json(await listResources(goal, ctx.workspaceId));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { goalId?: string; name?: string; kind?: string; content?: string | null; url?: string | null };
  if (!body.goalId || !body.name) return bad("goalId and name required", 400);
  const denied = await requireGoalEdit(ctx, body.goalId); if (denied) return denied;
  const kind = body.kind && RESOURCE_KINDS.has(body.kind) ? body.kind : "note";
  const url = cleanUrl(body.url);
  if (url === undefined && body.url) return bad("url は https:// か http:// で始めてください", 400);
  const content = typeof body.content === "string" ? body.content.slice(0, 20000) : null;
  return json(await createResource(body.goalId, String(body.name).slice(0, 200), ctx.workspaceId, kind, content, url ?? null));
}

export async function PATCH(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; name?: string; content?: string | null; url?: string | null; kind?: string };
  if (!body.id) return bad("id required", 400);
  const r = await first<{ goal_id: string | null }>("SELECT goal_id FROM resources WHERE id = ? AND workspace_id = ?", body.id, ctx.workspaceId);
  if (!r) return json({ error: "not found" }, { status: 404 });
  if (r.goal_id && !(await goalInScope(ctx.workspaceId, r.goal_id, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (r.goal_id && !(await canEditGoal(editor(ctx), r.goal_id, ctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.slice(0, 200);
  if (typeof body.content === "string" || body.content === null) patch.content = body.content === null ? null : body.content.slice(0, 20000);
  if (body.kind !== undefined) { if (!RESOURCE_KINDS.has(String(body.kind))) return bad("invalid kind", 400); patch.kind = body.kind; }
  if (body.url !== undefined) { const u = cleanUrl(body.url); if (u === undefined) return bad("url は https:// か http:// で始めてください", 400); patch.url = u; }
  await updateResource(body.id, patch, ctx.workspaceId);
  return json({ ok: true });
}
