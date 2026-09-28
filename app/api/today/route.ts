import { json, bad, first } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { listToday, setToday, clearToday } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const date = new URL(req.url).searchParams.get("date");
  if (!date) return bad("date required", 400);
  const rows = await listToday(date, ctx.workspaceId);
  if (!ctx.scopeGoalId) return json(rows);
  // scoped member: keep only items within the scope subtree.
  // ゴール行 (type: "goal") は自分自身の id で判定する。親 (project_id) で見ると
  // 最上位のゴールが today に入ったときに project_id が null になり、黙って
  // 落ちる — 「自分には何も無い」に化ける典型 (AGENTS.md 冒頭)。
  const seen = new Map<string, boolean>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const key = r.type === "goal" ? (r.id as string) : ((r.project_id as string | null) ?? null);
    if (!key) continue;
    let ok = seen.get(key);
    if (ok === undefined) {
      ok = await goalInScope(ctx.workspaceId, key, ctx.scopeGoalId);
      seen.set(key, ok);
    }
    if (ok) out.push(r);
  }
  return json(out);
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  // id はゴール(タスク)でも旧 node でもよい。nodeId は既存の呼び出しのために残す。
  const body = (await req.json().catch(() => ({}))) as { id?: string; nodeId?: string; date?: string | null };
  const id = body.id ?? body.nodeId;
  if (!id) return bad("id required", 400);
  const asGoal = await first<{ id: string }>("SELECT id FROM projects WHERE id = ? AND workspace_id = ?", id, ctx.workspaceId);
  if (asGoal) {
    if (!(await goalInScope(ctx.workspaceId, id, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  } else {
    const n = await first<{ project_id: string | null }>("SELECT project_id FROM nodes WHERE id = ? AND workspace_id = ?", id, ctx.workspaceId);
    if (!n) return json({ error: "not found" }, { status: 404 });
    if (n.project_id && !(await goalInScope(ctx.workspaceId, n.project_id, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  }
  await setToday(id, body.date ?? null, ctx.workspaceId);
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const date = new URL(req.url).searchParams.get("date");
  if (!date) return bad("date required", 400);
  await clearToday(date, ctx.workspaceId);
  return json({ ok: true });
}
