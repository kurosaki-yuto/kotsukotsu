import { json } from "../../lib/server/db";
import { requireWorkspace } from "../../lib/server/workspace";
import { getOrgSettings, updateOrgSettings } from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  return json(await getOrgSettings(ctx.workspaceId));
}

export async function PATCH(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  await updateOrgSettings(patch, ctx.workspaceId);
  return json({ ok: true });
}
