import { json, bad } from "../../../../lib/server/db";
import { requireWorkspace } from "../../../../lib/server/workspace";
import { getTemplate, listTemplatePlaybooks, linkTemplatePlaybook } from "../../../../lib/server/queries";

// 型に結んだ前例と、結ぶ候補 (?q= で題名・語を探す)
export async function GET(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t || t.archived_at) return json({ error: "not found" }, { status: 404 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return json(await listTemplatePlaybooks(id, ctx.workspaceId, q.slice(0, 100)));
}

// 前例を型に結ぶ / 外す。直せる人 = 管理者と型を作った本人
export async function POST(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t || t.archived_at) return json({ error: "not found" }, { status: 404 });
  if (!(ctx.role === "admin" || (!!t.created_by && t.created_by === ctx.user.id))) return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { playbook_id?: unknown; unlink?: unknown } | null;
  if (!body || typeof body.playbook_id !== "string") return bad("playbook_id が必要です", 400);
  const ok = await linkTemplatePlaybook(id, body.playbook_id, ctx.workspaceId, body.unlink === true);
  if (!ok) return bad("前例が見つかりません", 404);
  return json({ ok: true });
}
