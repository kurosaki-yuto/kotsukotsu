-- 通知の宛先を「配信した時点」で固定する。
-- 従来は一覧の可視範囲を毎回 goal_members から計算し直していたため、
-- アサインを外す/タスクを別の親へ移動する と、その人に届いていた過去の通知が
-- まとめて消えていた。配信時の宛先をここに記録し、以後は消さない。
CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_id TEXT NOT NULL,
  email TEXT NOT NULL,
  PRIMARY KEY (notification_id, email)
);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_email ON notification_recipients(email);
