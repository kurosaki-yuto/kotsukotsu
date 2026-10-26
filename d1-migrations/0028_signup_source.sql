-- 新規登録した人が、どこから来たか。「どの投稿・検索から登録が生まれたか」を数えるため。
-- 入れるのは、最初に開いたページの参照元のドメイン (別のサイトから来たときだけ)・URL の utm_source / utm_medium / utm_campaign・最初に開いたページのパス。
-- ブラウザのタブ内の一時保存 (sessionStorage) に置いた値を、登録のときに一緒に送る (app/lib/firstTouch.ts)。
-- この列ができる前に登録した人は空のまま。招待で入った人も同じ形で入る。
ALTER TABLE users ADD COLUMN signup_ref TEXT;
ALTER TABLE users ADD COLUMN signup_utm_source TEXT;
ALTER TABLE users ADD COLUMN signup_utm_medium TEXT;
ALTER TABLE users ADD COLUMN signup_utm_campaign TEXT;
ALTER TABLE users ADD COLUMN signup_landing TEXT;
