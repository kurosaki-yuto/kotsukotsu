-- 型 (playbook)。完了したタスクから「何をするときに・どの順で・何に気をつけたか」を抜き出したもの。
-- 誰かがやったことを、別のメンバーの AI が同じ種類の仕事をするときに MCP の返り値で受け取る。
-- 型は全メンバーに見せる前提なので、顧客名・金額・個人情報は入れない (書くのは record_playbook の呼び手)。
-- 元タスク名は入れない。見せるときに source_goal_id から引き、呼び手が見える範囲にあるときだけ出す。
CREATE TABLE IF NOT EXISTS playbooks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  source_goal_id  TEXT,
  author_name     TEXT,
  author_email    TEXT,
  title           TEXT NOT NULL,   -- 何をするときの型か
  keywords        TEXT,            -- 探すときの語 (改行区切り)
  steps           TEXT NOT NULL,   -- 手順
  pitfalls        TEXT,            -- 気をつけたこと・つまずいたこと
  commits         TEXT,            -- JSON [{repo, sha, message}]
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playbooks_ws_updated ON playbooks(workspace_id, updated_at);
-- 1つのタスクから起こす型は1つ。書き直しは上書き。
CREATE UNIQUE INDEX IF NOT EXISTS idx_playbooks_source ON playbooks(workspace_id, source_goal_id) WHERE source_goal_id IS NOT NULL;
