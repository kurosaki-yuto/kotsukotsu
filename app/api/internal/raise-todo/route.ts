import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { json, bad, first, run, uid } from "../../../lib/server/db";
import { assignWorkspaceOwnerAsHolder } from "../../../lib/server/queries";

/** Constant-time-ish string compare to avoid trivial timing leaks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// こつこつシリーズの他の製品から、こつこつ本体へ ToDo を起こすための口。
//
// 何のためにあるか: マーケや営業は「目標に対して何件足りないか」を持っている。
// 足りないと分かった時点で、やることが こつこつ に並んでいないと誰も動かない。
// 数字を持っている側から、実行を管理している側へ渡すための1本道。
//
// 呼び出しは service binding 経由に限り、SSO_SECRET でも守る
// (*.workers.dev 同士の fetch は Cloudflare に塞がれて 404 になる)。
//
// 同じ文言を何度も起こさないよう、呼び出し側が dedupeKey を持つ。
// ここでは同じ親の下に同じ名前のサブタスクが既にあれば、それを返して作らない。
export async function POST(req: Request) {
  const env = getCloudflareContext().env as unknown as { SSO_SECRET?: string };
  const secret = env.SSO_SECRET;
  if (!secret) return json({ error: "not configured" }, { status: 501 });
  if (!safeEqual(req.headers.get("x-sso-secret") ?? "", secret)) {
    return json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    parentGoalId?: string;
    text?: string;
    workspaceId?: string;
  };
  const parentGoalId = (body.parentGoalId ?? "").trim();
  const text = (body.text ?? "").trim();
  if (!parentGoalId || !text) return bad("parentGoalId and text required", 400);

  const parent = await first<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM projects WHERE id = ?",
    parentGoalId
  );
  if (!parent) return bad("parent goal not found", 404);

  // 既に同じ文言が同じ親の下にあるなら、それを返して作らない。
  // 毎月まわすものなので、ここで止めないとサブタスクが積み上がっていく。
  const dup = await first<{ id: string }>(
    "SELECT id FROM projects WHERE parent_goal_id = ? AND name = ? AND status <> 'archived'",
    parentGoalId,
    text
  );
  if (dup) return json({ ok: true, id: dup.id, created: false });

  const order = await first<{ n: number }>(
    "SELECT COALESCE(MAX(order_idx), -1) + 1 AS n FROM projects WHERE parent_goal_id = ?",
    parentGoalId
  );

  const id = uid();
  await run(
    "INSERT INTO projects (id, name, parent_goal_id, workspace_id, order_idx, status) VALUES (?,?,?,?,?,'active')",
    id, text, parentGoalId, parent.workspace_id, order?.n ?? 0
  );
  // 人が作ったものと同じで、担当が空のまま増えないようにする
  await assignWorkspaceOwnerAsHolder(id, parent.workspace_id);
  return json({ ok: true, id, created: true });
}
