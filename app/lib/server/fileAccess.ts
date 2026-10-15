import "server-only";
import { json } from "./db";
import { goalInScope, requireGoalEdit, type WorkspaceCtx } from "./workspace";
import { getTemplate } from "./queries";

// R2 のキーの決まりと、誰が読めて誰が書けるか。
//   ゴールのファイル: <ワークスペース>/<ゴールid>/<uuid>-<名前>
//   型のファイル    : <ワークスペース>/templates/<型id>/<uuid>-<名前>
// 型のファイルは、型を振ったゴールのリソースからも同じキーで参照する (コピーしない)。
// ゴール側でリソースを消しても、削除はゴールの接頭辞のキーにしか効かないので型のファイルは残る。
export type FileTarget = { kind: "goal"; goalId: string } | { kind: "template"; templateId: string };

export function keyPrefix(wsId: string, t: FileTarget): string {
  return t.kind === "goal" ? `${wsId}/${t.goalId}/` : `${wsId}/templates/${t.templateId}/`;
}

/** キーからどのゴール・型のファイルかを読む。ワークスペースが違う・形が違うキーは null。 */
export function targetOfKey(wsId: string, key: string): FileTarget | null {
  const parts = key.split("/");
  if (parts[0] !== wsId || parts.some((p) => !p || p === "." || p === "..")) return null;
  if (parts[1] === "templates") return parts.length >= 4 ? { kind: "template", templateId: parts[2] } : null;
  return parts.length >= 3 ? { kind: "goal", goalId: parts[1] } : null;
}

/** 読めるか: ゴールのファイルはそのゴールが見える人、型のファイルはワークスペースの全員 (型の一覧は全員に見える)。 */
export async function canReadTarget(ctx: WorkspaceCtx, t: FileTarget): Promise<boolean> {
  if (t.kind === "goal") return goalInScope(ctx.workspaceId, t.goalId, ctx.scopeGoalId);
  const tpl = await getTemplate(t.templateId, ctx.workspaceId);
  return !!tpl;
}

/** 書けるか: ゴールは編集できる人、型は管理者と型を作った本人。だめなら応答を返す。 */
export async function denyWrite(ctx: WorkspaceCtx, t: FileTarget): Promise<Response | null> {
  if (t.kind === "goal") return requireGoalEdit(ctx, t.goalId);
  const tpl = await getTemplate(t.templateId, ctx.workspaceId);
  if (!tpl || tpl.archived_at) return json({ error: "not found" }, { status: 404 });
  if (!(ctx.role === "admin" || (!!tpl.created_by && tpl.created_by === ctx.user.id))) return json({ error: "forbidden" }, { status: 403 });
  return null;
}
