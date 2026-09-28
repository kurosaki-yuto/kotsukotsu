-- 「バッジを消す」と「既読にする」を分ける。
-- 通知ページを開いた時点で全件を既読にすると、何が新着だったのか分からなくなる
-- (0016以前の挙動)。かといってバッジが残り続けるのも邪魔。
-- そこで開いた時刻だけを記録し、バッジ = その時刻より後に来た未読 とする。
-- 一覧の未読マークは read_at ベースのままなので、開くだけでは消えない。
CREATE TABLE IF NOT EXISTS notification_seen (
  email TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (email, workspace_id)
);
