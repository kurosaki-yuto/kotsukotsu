-- 完了の基準・現状の「これでいい？」と、タスクが親の完了の基準のどの行を埋めるか (黒崎判断 2026-11-02)。
-- 目標 → 完了の基準 → 現状 → その差がタスク、を崩さないため。app/lib/server/qualityCore.ts が正。

-- このタスクが埋める、親の完了の基準の行 (add_subtask の closes を親の基準と突き合わせた文)。NULL は以前のタスク・画面で作ったタスク。
ALTER TABLE projects ADD COLUMN closes_criteria TEXT;

-- AI が書き換えた完了の基準・現状を、書かせた本人に「これでいい？ はい / いいえ」と一度出す。
-- applied = 1: もう反映した (いいえで before_text に戻す) / 0: まだ反映していない (はいで after_text を入れる)。
-- status: pending / accepted (はい) / rejected (いいえ) / superseded (同じ欄の新しい確認に置き換わった)。
CREATE TABLE IF NOT EXISTS goal_confirmations (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  goal_id           TEXT NOT NULL,
  field             TEXT NOT NULL,          -- completion_criteria / current_state
  before_text       TEXT,
  after_text        TEXT NOT NULL,
  reason            TEXT,
  applied           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pending',
  requested_by      TEXT,                   -- users.id (AI を動かしていた本人)
  requested_by_name TEXT,
  created_at        TEXT NOT NULL,
  decided_at        TEXT,
  decided_by_name   TEXT
);
CREATE INDEX IF NOT EXISTS idx_goal_confirmations_user ON goal_confirmations(workspace_id, requested_by, status, created_at);
CREATE INDEX IF NOT EXISTS idx_goal_confirmations_goal ON goal_confirmations(workspace_id, goal_id, status);
