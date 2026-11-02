import { json, bad } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import { listMyConfirmations, listGoalConfirmations, answerConfirmation, getConfirmation } from "../../lib/server/queries";
import { notifyWorkspace } from "../../lib/server/realtime";

// 完了の基準・現状の「これでいい？」。?goal=<id> でそのゴールの分、無ければ自分の AI が書いた分。
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const goal = new URL(req.url).searchParams.get("goal");
  if (goal) {
    if (!(await goalInScope(ctx.workspaceId, goal, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
    return json(await listGoalConfirmations(ctx.workspaceId, goal));
  }
  return json(await listMyConfirmations(ctx.workspaceId, ctx.user.id));
}

// まとめてはい: { yes_all: true } で自分の分を全部はいにする
export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { yes_all?: boolean; ids?: unknown } | null;
  if (!body?.yes_all) return bad("yes_all required", 400);
  const mine = await listMyConfirmations(ctx.workspaceId, ctx.user.id, 500);
  const pick = Array.isArray(body.ids) ? new Set(body.ids.filter((x): x is string => typeof x === "string")) : null;
  let n = 0;
  for (const c of mine) {
    if (pick && !pick.has(c.id)) continue;
    const fresh = await getConfirmation(ctx.workspaceId, c.id);
    if (!fresh || fresh.status !== "pending") continue;
    await answerConfirmation(ctx.workspaceId, fresh, true, { name: ctx.user.name, email: ctx.user.email }, null);
    n++;
  }
  notifyWorkspace(ctx.workspaceId);
  return json({ ok: true, accepted: n });
}
