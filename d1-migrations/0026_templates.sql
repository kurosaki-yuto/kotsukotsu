-- 型 (テンプレート)。「必要なデータ (入力値・資料リンク) + タスクの木」をひとまとめにした再利用の単位。
-- 終えたゴールのタスク木から起こし、メンバーを選んで振ると、新しいゴール + 子タスク + リソース + 担当が一度に入る。
-- 既存の playbooks (AI にだけ渡る自由文の前例) とは別物。人が一覧で見て、人に振るためのもの。
-- inputs / tasks / resources は JSON 文字列。構造は app/lib/server/templateCore.ts の型を正とする。
CREATE TABLE IF NOT EXISTS templates (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  name                TEXT NOT NULL,              -- 型の名前。{{入力}} で差し込める
  purpose             TEXT,                       -- 何のための型か・期待する成果
  completion_criteria TEXT,                       -- 新しいゴールの完了の基準。{{入力}} 可
  inputs              TEXT NOT NULL DEFAULT '[]', -- [{label, hint, required}]
  tasks               TEXT NOT NULL DEFAULT '[]', -- [{text, completion_criteria, children:[...]}]
  resources           TEXT NOT NULL DEFAULT '[]', -- [{name, url}]
  source_goal_id      TEXT,                       -- 元になったゴール (あれば)
  created_by          TEXT,                       -- users.id
  author_name         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  archived_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_templates_ws ON templates(workspace_id, archived_at, updated_at);
-- 型から作ったゴールの印。型の画面で「この型から作ったゴール」と使った回数を出すため。
ALTER TABLE projects ADD COLUMN template_id TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_template ON projects(template_id);
