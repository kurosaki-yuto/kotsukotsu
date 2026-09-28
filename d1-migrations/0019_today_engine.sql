-- 「今日何したらいいの?」に即答するためのエンジン。
--
-- 前提となる事実: このアプリにはタスクモデルが2つある。生きているのは
-- projects (ゴール=タスク、parent_goal_id で入れ子) で、`/` と `/goals/[id]`
-- が描画しているのはこちら。一方 nodes (アウトライナー) は UI から切れており、
-- Outliner.tsx / Sidebar.tsx はどこからも import されていない。
-- ところが today_date は切れている nodes 側にしか無かったため、list_today は
-- 常に 0 件を返していた。データが無いのではなく線が繋がっていなかった。
-- ここで today_date を生きている側に持たせる。

ALTER TABLE projects ADD COLUMN today_date TEXT;

-- 「その提案は実行されたか」「今週いくつ閉じたか」を測るのに完了時刻が要る。
-- projects には status='done' しか無く、いつ完了したのかが残っていない
-- (done_log は nodes 側の完了しか書かない)。既存の 2,000 件超の done には
-- 入れられない — 記録が存在しないので埋めると嘘になる。今後の完了分だけ入る。
ALTER TABLE projects ADD COLUMN completed_at TEXT;

CREATE INDEX IF NOT EXISTS projects_today_idx ON projects(workspace_id, today_date);

-- 提示した内容のスナップショット。「誰に何を出したか」は出した時点の事実なので
-- 保存する (AGENTS.md #4)。現在のスコアから再計算すると、明日スコアが変われば
-- 昨日何を薦めたのかが消え、「やりかけ」も「却下済み」も判定できなくなる。
CREATE TABLE IF NOT EXISTS today_briefs (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id   TEXT NOT NULL,
  member_email   TEXT NOT NULL,
  date           TEXT NOT NULL,                    -- YYYY-MM-DD (ワークスペースのタイムゾーン)
  goal_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rank           INTEGER NOT NULL,
  action_text    TEXT NOT NULL,
  reason         TEXT,
  estimate_min   INTEGER,
  score          REAL,
  signals        TEXT,                             -- JSON: スコアの内訳
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  accepted_at    TEXT,
  done_at        TEXT,
  dismissed_at   TEXT,
  dismiss_reason TEXT
);
CREATE INDEX IF NOT EXISTS today_briefs_lookup_idx
  ON today_briefs(workspace_id, member_email, date);
-- 却下ペナルティと「やりかけ」判定は goal_id で引くので、その経路にも索引を張る。
CREATE INDEX IF NOT EXISTS today_briefs_goal_idx
  ON today_briefs(goal_id, date);

-- 段2 (LLM で「次の一手」を1文にする) のキャッシュ。cache_key は goal の
-- 中身のハッシュなので、goal が動かない限り再推論しない。
CREATE TABLE IF NOT EXISTS goal_next_action (
  goal_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL,
  cache_key      TEXT NOT NULL,
  action_text    TEXT,
  minutes        INTEGER,
  blocker        TEXT,
  why            TEXT,
  -- 現状が古くて次の一手が決められなかった場合。候補から外し、
  -- 「現状を更新すれば明日から候補に入る」として人に返す。
  state_is_stale INTEGER NOT NULL DEFAULT 0,
  model          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS goal_next_action_ws_idx ON goal_next_action(workspace_id);
