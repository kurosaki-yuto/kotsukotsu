-- ログインの失敗回数。総当たりを止めるため、メールアドレスごと・接続元 IP ごとに数える。
-- key は "email:<小文字のメール>" か "ip:<IP>"。window_start から15分で数え直す。
CREATE TABLE IF NOT EXISTS login_failures (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT NOT NULL
);
