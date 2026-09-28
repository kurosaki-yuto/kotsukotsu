-- 既読をユーザー単位にする。従来は notifications.read_at 1本を全員で共有していた
-- ため、誰かが通知ページを開く(=markAllRead)と他のメンバーの未読まで消えていた。
-- 既存の read_at は「全員既読」の旧データとしてそのまま読み、以後は書かない。
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id TEXT NOT NULL,
  email TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (notification_id, email)
);
CREATE INDEX IF NOT EXISTS idx_notification_reads_email ON notification_reads(email);
