import { json } from "../../../lib/server/db";
import { requireWorkspace } from "../../../lib/server/workspace";
import { memberTaskProgress } from "../../../lib/server/queries";

// Admin-only: who still has undone assigned tasks (pending > 0).
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const rows = (await memberTaskProgress(ctx.workspaceId)) as Record<string, unknown>[];
  return json(rows.map((r) => ({ ...r, is_you: !!r.is_you })));
}
