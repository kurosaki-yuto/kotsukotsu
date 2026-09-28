import { json, bad } from "../../lib/server/db";
import { requireWorkspace } from "../../lib/server/workspace";
import { listMembers, rankedMembers, inviteMember } from "../../lib/server/queries";

function coerceMember(row: Record<string, unknown>) {
  return { ...row, is_ai: !!row.is_ai, is_you: !!row.is_you };
}

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const ranked = new URL(req.url).searchParams.get("ranked");
  const rows = ranked ? await rankedMembers(ctx.workspaceId) : await listMembers(ctx.workspaceId);
  return json((rows as Record<string, unknown>[]).map(coerceMember));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { name?: string; email?: string };
  if (!body.name) return bad("name required", 400);
  const row = await inviteMember(body.name, ctx.workspaceId, body.email);
  return json(row ? coerceMember(row as Record<string, unknown>) : null);
}
