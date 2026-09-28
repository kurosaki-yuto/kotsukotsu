import { requireWorkspace } from "../../lib/server/workspace";
import { json } from "../../lib/server/db";
import { getApiKey, regenApiKey } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  return json({ token: await getApiKey(ctx.workspaceId) });
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  return json({ token: await regenApiKey(ctx.workspaceId) });
}
