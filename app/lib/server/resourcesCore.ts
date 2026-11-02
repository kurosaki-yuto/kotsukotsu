// タスクで使う資料 (そのタスク + 上のゴールに付いた資料)。Web と mcp-worker の両方から使うので純粋な関数だけ。
// 黒崎判断 2026-11-02: 上のゴール (顧客の箱など) に上げた資料は、その下のタスクを見られる人も読める。
// 資料はタスクに要る情報なので、リンクを配って権限を付ける代わりにタスクと一緒に渡す。

export type InheritedResource = {
  id: string;
  goal_id: string;
  goal_name: string | null;
  /** 0 = このタスク自身、1 = 親、2 = その上 … */
  depth: number;
  name: string;
  kind: string;
  /** 説明 (アップロード時の caption など) */
  content: string | null;
  url: string | null;
};

const MAX_DEPTH = 20;

/** goalId から上へ辿った各段のリソースを、近い順 (同じ段は新しい順) に返す。 */
export async function inheritedResources(db: D1Database, wsId: string, goalId: string, limit = 50): Promise<InheritedResource[]> {
  const { results } = await db.prepare(
    `WITH RECURSIVE up(id, parent, name, depth) AS (
       SELECT id, parent_goal_id, name, 0 FROM projects WHERE id = ? AND workspace_id = ?
       UNION ALL
       SELECT p.id, p.parent_goal_id, p.name, up.depth + 1 FROM up CROSS JOIN projects p ON p.id = up.parent
        WHERE p.workspace_id = ? AND up.depth < ?
     )
     SELECT r.id, r.goal_id, up.name AS goal_name, up.depth, r.name, r.kind, r.content, r.url
       FROM up JOIN resources r ON r.goal_id = up.id AND r.workspace_id = ?
      ORDER BY up.depth ASC, r.updated_at DESC, r.id
      LIMIT ?`
  ).bind(goalId, wsId, wsId, MAX_DEPTH, wsId, limit).all<InheritedResource>();
  return results ?? [];
}

/**
 * ancestorId が、roots のどれかの「上のゴール」(自分自身を含む) か。
 * 子タスクだけ担当している人が、上のゴールのファイルを読めるかの判定に使う。roots は JSON で渡す (件数でバインドの上限に当たらないように)。
 */
export async function isAncestorOfAny(db: D1Database, wsId: string, ancestorId: string, roots: string[]): Promise<boolean> {
  if (!roots.length) return false;
  const r = await db.prepare(
    `WITH RECURSIVE up(id, parent, depth) AS (
       SELECT p.id, p.parent_goal_id, 0 FROM projects p, json_each(?) j WHERE p.id = j.value AND p.workspace_id = ?
       UNION
       SELECT p.id, p.parent_goal_id, up.depth + 1 FROM up CROSS JOIN projects p ON p.id = up.parent
        WHERE p.workspace_id = ? AND up.depth < ?
     )
     SELECT 1 AS ok FROM up WHERE id = ? LIMIT 1`
  ).bind(JSON.stringify(roots), wsId, wsId, MAX_DEPTH, ancestorId).first<{ ok: number }>();
  return !!r;
}

/** AI に渡すときの説明 (get_goal / start_task の files に添える)。 */
export const FILES_NOTE =
  "files はこのタスクと上のゴール (顧客の箱など) に付いた資料。depth 0 がこのタスク、数字が大きいほど上。" +
  "手を動かす前に、このタスクに関係しそうなものを読む (url が r2: で始まるものは get_file で中身を読める)。フォルダや過去のやり取りを探しに行く前にここを見る。" +
  "毎回使う書式・前回分などは upload_file で上のゴールに上げておくと、その下のタスク全部で使える。";
