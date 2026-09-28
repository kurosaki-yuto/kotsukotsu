import { json } from "../../lib/server/db";
import { requireWorkspace } from "../../lib/server/workspace";
import { computeStreak } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json({ streak: await computeStreak(ctx.workspaceId) });
}
