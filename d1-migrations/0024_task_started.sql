-- タスクの「進行中」。status は active / done のまま触らず、開始した事実だけを足す
-- (status に値を増やすと status = 'active' を前提にした一覧・通知・自己診断が全部ずれる)。
-- status = 'active' かつ started_at がある = 進行中。
-- 誰が始めたかは開始した時点の名前を残す (後から名前やアサインが変わっても書き換えない)。
ALTER TABLE projects ADD COLUMN started_at TEXT;
ALTER TABLE projects ADD COLUMN started_by TEXT;       -- users.id
ALTER TABLE projects ADD COLUMN started_by_name TEXT;  -- 開始した時点の表示名
ALTER TABLE projects ADD COLUMN started_via TEXT;      -- 'app' = 画面のボタン / それ以外 = AI の名前 (Claude Code・Codex など)
