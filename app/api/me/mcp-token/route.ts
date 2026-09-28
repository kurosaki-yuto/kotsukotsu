import { json } from "../../../lib/server/db";
import { requireWorkspace } from "../../../lib/server/workspace";
import { getMemberApiKey, regenMemberApiKey } from "../../../lib/server/queries";

// The caller's own MCP key for their ACTIVE workspace membership. Any member
// may hold one — the MCP worker enforces their role + goal scope server-side.
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json({ token: await getMemberApiKey(ctx.workspaceId, ctx.user.id) });
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json({ token: await regenMemberApiKey(ctx.workspaceId, ctx.user.id) });
}
