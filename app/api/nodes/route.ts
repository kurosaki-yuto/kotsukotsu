import { json, bad } from "../../lib/server/db";
import { requireWorkspace, goalInScope } from "../../lib/server/workspace";
import {
  listProjectNodes,
  insertNodeAfter,
  updateNodeText,
  toggleNodeComplete,
  deleteNode,
  indentNode,
  outdentNode,
  moveNode,
  updateNodeDue,
  canEditGoal,
  nodeGoalId,
  getGoal,
} from "../../lib/server/queries";

export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const project = new URL(req.url).searchParams.get("project");
  if (!project) return bad("project required", 400);
  return json(await listProjectNodes(project, ctx.workspaceId));
}

export async function POST(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const op = body.op as string | undefined;

  // resolve the affected goal; insertAfter targets a project directly, every
  // other op resolves it from the node (workspace-scoped, so a foreign/unknown
  // node id yields null).
  const goalId = op === "insertAfter"
    ? ((body.projectId as string) ?? null)
    : body.id ? await nodeGoalId(body.id as string, ctx.workspaceId) : null;
  // the target project must exist in THIS workspace (closes cross-workspace
  // node ops that bypass the per-row filter, e.g. indent/outdent/move by id).
  if (!goalId || !(await getGoal(goalId, ctx.workspaceId))) return json({ error: "not found" }, { status: 404 });
  if (!(await goalInScope(ctx.workspaceId, goalId, ctx.scopeGoalId))) return json({ error: "not found" }, { status: 404 });
  if (!(await canEditGoal({ id: ctx.user.id, email: ctx.user.email, role: ctx.role }, goalId, ctx.workspaceId))) return json({ error: "forbidden" }, { status: 403 });

  switch (op) {
    case "insertAfter": {
      const node = await insertNodeAfter({
        id: body.id as string | undefined,
        projectId: body.projectId as string,
        parentId: (body.parentId ?? null) as string | null,
        afterId: (body.afterId ?? null) as string | null,
        text: body.text as string | undefined,
        wsId: ctx.workspaceId,
      });
      return json(node);
    }
    case "update":
      await updateNodeText(body.id as string, (body.text ?? "") as string, ctx.workspaceId);
      return json({ ok: true });
    case "toggle":
      await toggleNodeComplete(body.id as string, !!body.completed, ctx.workspaceId);
      return json({ ok: true });
    case "delete":
      await deleteNode(body.id as string, ctx.workspaceId);
      return json({ ok: true });
    case "indent":
      await indentNode(body.id as string);
      return json({ ok: true });
    case "outdent":
      await outdentNode(body.id as string);
      return json({ ok: true });
    case "move":
      await moveNode({
        id: body.id as string,
        newParentId: (body.newParentId ?? null) as string | null,
        newIndex: Number(body.newIndex ?? 0),
      });
      return json({ ok: true });
    case "setDue":
      await updateNodeDue(body.id as string, (body.dueAt ?? null) as string | null, ctx.workspaceId);
      return json({ ok: true });
    default:
      return bad("unknown op", 400);
  }
}
