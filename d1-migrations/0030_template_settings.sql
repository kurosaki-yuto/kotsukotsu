-- 型の見える範囲・自分だけのメモ・機能・繰り返し (docs/plans/2026-11-02_型の定期実行・見える範囲・機能分類.md、黒崎承認 2026-11-02)。
--
-- visibility: 誰が型を読めるか。
--   private   = 作った人と管理者だけ
--   assigned  = 上 + その型から作ったゴール (配下のタスク含む) の担当者。担当を外れたら読めなくなる
--   workspace = ワークスペースのメンバー全員 (この列ができる前と同じ)
--   既にある型は今までどおり全員に見えるよう 'workspace' で入れる。新しく作る型の既定 ('assigned') はコードで入れる。
ALTER TABLE templates ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
-- 自分だけのメモ。作った人と管理者にしか返さない (道具の置き場所・アカウントなど)。履歴 (template_revisions) と外への書き出しには載せない。
ALTER TABLE templates ADD COLUMN private_note TEXT;
-- 機能 (経営 / 財務 / 法務 / 集客 / 営業 / CS / その他)。型の一覧をこの区分で並べる。NULL は未分類。
ALTER TABLE templates ADD COLUMN function TEXT;
-- 繰り返し。{"freq":"daily"|"weekly"|"monthly","time":"HH:MM","weekday":0-6,"day":1-31}。時刻はワークスペースのタイムゾーン。NULL は繰り返さない。
ALTER TABLE templates ADD COLUMN schedule TEXT;
-- 繰り返しで振る先。{"parent_id","member_id","values":{},"deadline_days"}。
ALTER TABLE templates ADD COLUMN schedule_target TEXT;
-- 最後に繰り返しで動いた回 (ワークスペースの日付と時刻 "YYYY-MM-DDTHH:MM")・動いた日時・作ったゴール。同じ回を二度振らないため。
ALTER TABLE templates ADD COLUMN last_run_key TEXT;
ALTER TABLE templates ADD COLUMN last_run_at TEXT;
ALTER TABLE templates ADD COLUMN last_run_goal_id TEXT;
