-- 誰がタスクを完了にしたか。「今日・今週に誰が何件終えたか」を数えるため (タスク画面の「終えたタスク」)。
-- 完了にした人のメールを入れる (画面のボタンならその人、AI ならそのトークンの持ち主)。
-- 親を完了にしたときに一緒に閉じた配下 (cascadeGoalDone) には入れない。数えるのは自分で閉じたものだけ。
-- この列ができる前の完了は空のまま (数えるときは担当者で代わりに数える。queries.ts の listDoneCounts)。
ALTER TABLE projects ADD COLUMN completed_by TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_ws_completed ON projects(workspace_id, completed_at);
