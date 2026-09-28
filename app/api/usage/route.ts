import { requireWorkspace } from "../../lib/server/workspace";
import { json } from "../../lib/server/db";
import { usageStats } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await usageStats(ctx.workspaceId));
}
