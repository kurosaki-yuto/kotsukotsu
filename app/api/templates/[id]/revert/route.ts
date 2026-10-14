import { json, bad } from "../../../../lib/server/db";
import { requireWorkspace } from "../../../../lib/server/workspace";
import { getTemplate, revertRevision } from "../../../../lib/server/queries";

// 型の履歴の 1 版を取り消す (その版の「直す前」に戻す)。直せる人 = 管理者と作った本人
export async function POST(req: Request, c: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const { id } = await c.params;
  const t = await getTemplate(id, ctx.workspaceId);
  if (!t || t.archived_at) return json({ error: "not found" }, { status: 404 });
  if (!(ctx.role === "admin" || (!!t.created_by && t.created_by === ctx.user.id))) return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { revision_id?: unknown } | null;
  if (!body || typeof body.revision_id !== "string") return bad("revision_id が必要です", 400);
  let exportError: string | null;
  try {
    exportError = await revertRevision(t, body.revision_id, ctx.workspaceId, ctx.user.name || ctx.user.email);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "戻せませんでした", 404);
  }
  return json({ ...(await getTemplate(id, ctx.workspaceId)), ...(exportError ? { export_error: exportError } : {}) });
}
