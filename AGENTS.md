<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 「立ち上げて」「セットアップして」と頼まれたら

このリポジトリを受け取った人の AI (Claude Code / Codex / Cursor など) は、以下をそのまま進める。
こつこつは使う会社・人がそれぞれ自分でデータベースとデプロイ先を作る設計で、共有のサーバーは無い。
立て方は2通りあり、機能は同じ。

- **Cloudflare 版**: 利用者の Cloudflare アカウントに作る。サーバーの管理が要らない。詳しくは `docs/self-hosting.md`
- **Docker 版**: Docker が動く所 (AWS・Google Cloud・Azure・VPS・社内サーバー・手元のパソコン) ならどこでも。詳しくは `docs/self-hosting-docker.md`

`.setup.json` が既にあれば立ち上げ済み。`platform` が `docker` なら Docker 版、無ければ Cloudflare 版。そのときは下の「最新にして」の手順へ。

## 共通の最初の手順

1. `node -v` が 20 以上か確かめる。足りなければ利用者に Node.js 20 以上を入れてもらう
2. 利用者に「Cloudflare で立てますか、それとも Cloudflare 以外 (AWS・社内サーバーなど、Docker で動かす) ですか」と聞く。
   特に希望が無く、サーバーを持っていないなら Cloudflare 版をすすめる

## Cloudflare 版

1. `npm install`
2. 利用者に会社名やチーム名を聞き、環境の名前を決めて確認を取る。Worker・データベースの名前の元になる
   (英小文字・数字・ハイフン、3〜40文字。例: 株式会社アクメ → `acme-kotsukotsu`)
3. `npm run setup -- --name <名前>` を実行する。**数分かかるのでタイムアウトは 10 分以上にする**
   - 同じ名前の Worker・データベースが既にあると「上書きしないよう止めました」で止まる。
     それは誰かの稼働中の環境なので、**絶対にその名前で押し通さない**。別の名前を利用者と決めて再実行する
   - 未ログインだとブラウザで Cloudflare のログイン画面が開く。利用者に「ブラウザで許可してください」と伝えて待つ
   - アカウントが複数あると候補の一覧を出して止まる。どれに作るかを利用者に聞いて `npm run setup -- --account <ID>` で再実行する
   - `workers.dev のサブドメインが分かりませんでした` で止まったら、Cloudflare ダッシュボードの Workers & Pages でサブドメインを登録してもらい、再実行する
   - R2 が使えないという警告は止まらなくてよい (ファイル添付だけ使えない)。有効化の方法は self-hosting.md

## Docker 版

1. `docker compose version` と `docker info` で Docker が使えるか確かめる。無ければ Docker Desktop (か Docker Engine) を入れて起動してもらう
2. 利用者に「このパソコンだけで使うか、サーバーに置いてみんなで使うか」を聞く
   - このパソコンだけ: `npm run setup:docker`
   - サーバーでみんなで: 使うドメインを聞き、DNS の A レコードがサーバーの IP を向いていて 80・443 番が開いていることを確認してもらってから
     `npm run setup:docker -- --domain <ドメイン>` (このコマンドはそのサーバーの上で実行する)
3. **初回はビルドに数分かかるのでタイムアウトは 10 分以上にする**。止まったら `docker compose logs kotsukotsu` を読んで原因を伝える

## 立ち上がったあと (共通)

1. 最後に出る「こつこつ」の URL を利用者に渡し、ブラウザで開いて「新規登録」してもらう。
   **パスワードは利用者本人が入れる。AI が代わりにアカウントを作らない**
2. Claude から使えるようにする: 利用者に 設定 → APIキー の「Claude Code（ターミナル）」のコマンドをコピーしてもらい、実行する。
   キー入りなので、コマンドやキーをファイル・コミット・ログに残さない。claude.ai で使うときは同じ画面の「接続用URL」をカスタムコネクタに貼る
3. 繋がったら、`list_goals` などのツールで読み書きできることを確かめて完了を伝える

「最新にして」「アップデートして」と頼まれたら `npm run update` を実行する (タイムアウトは 10 分以上)。
Cloudflare 版・Docker 版のどちらでも同じコマンドで、git pull → データベースのバックアップ (backups/) → 足りないテーブルだけ追加して再デプロイ、の順に進む。データは消えない。
更新のあとでおかしくなって「戻して」と頼まれたら、Docker 版は `npm run restore` (直前のバックアップに戻す)、Cloudflare 版は docs/self-hosting.md の「更新が失敗したとき」の D1 Time Travel。どちらも戻す前に利用者に確認を取る。
「setup 以外で書き換えたファイルがあります」で止まったら、利用者にそのファイルをどうするか聞く (勝手に戻さない)。
`.setup.json` と `.env` (Docker 版) には鍵が入っている。コミットしない・中身を表示しない。

# Cloudflare 版と Docker 版の両方で動かす

同じコードが Cloudflare (Workers + D1 + R2) と Docker (node-server: SQLite + ディスク) の両方で動く。
- env (DB・FILES・シークレット) は `app/lib/server/platform.ts` の `platformEnv()` から取る。`getCloudflareContext()` を直接呼ばない
- レスポンス後も続ける処理は `waitUntil()`、招待・再設定などのリンクの元は `publicOrigin(req)` を使う
- D1 の呼び方 (prepare().bind().first/all/run、batch) だけを使う。D1 にしか無い機能 (dump・withSession など) は使わない
- Workers AI など Cloudflare にしか無いものを使うときは、無いとき (Docker 版) の代わりの動きを必ず用意する
- 公開版への書き出しは、platform.ts 以外で `getCloudflareContext(` を見つけると止まる

# マイグレーション (d1-migrations/) は「足す」だけ

自社専用版は `npm run update` で、利用者の既存データの上にマイグレーションを当てる。
列・テーブルの削除 (DROP)、名前の変更 (RENAME)、行の削除 (DELETE / TRUNCATE) を書くと、利用者のデータが壊れる。
新しい列は ADD COLUMN (NULL 許可か DEFAULT 付き)、新しい表は CREATE TABLE IF NOT EXISTS で足す。
使わなくなった列やテーブルは消さずに残す。公開版への書き出しは、0023 以降にこれらが入っていると止まる。

# このアプリが壊れるときは、いつも同じ壊れ方をする

「エラーが出る」のではなく「**黙って空になる**」。取得が失敗しても画面は正常に描画され、
利用者には「自分には何も無い」ようにしか見えない。担当者アイコンが全部消えた件も、
通知が届かなくなった件も、原因は違うが症状はこれ1つだった。

新しいコードを書くときは、以下を必ず守る。

## 1. 取得失敗を空配列にすり替えない

`.catch(() => [])` で握り潰すと、故障と「0件」が区別できなくなる。
どうしても画面を描き続けたいなら、失敗した事実を必ず利用者に見せる。
`app/lib/addness.ts` の `api()` が全失敗を `kotsukotsu:fetch-error` として発火し、
`LoadFailureBanner` がバナーを出す。**この経路を通らない生 fetch を書かない**。

## 2. `IN (...)` に可変長の配列をそのままバインドしない

D1 は1クエリあたりのバインド変数に上限がある。上限を超えるとクエリごと失敗し、
呼び出し側の `catch` が空を返すので 1 の症状になる。件数が増える可能性のある
id/メールのリストは、**必ず50件ずつにチャンクする**か、`WITH RECURSIVE` で
SQL 内で解決してバインドしない (`memberRelevantGoalIds` / `goalVisibilityClause` が実例)。

## 3. `LIMIT` を付けるならページングもセットで付ける

`LIMIT 100` だけ書くと、超えた分は「無い」のと区別が付かない。
一覧を返す API は `offset` を受け取り `{ items, hasMore }` を返す
(`listNotifications` が実例)。集計目的で上限を切る場合も `ORDER BY` を必ず付けて、
どの範囲を見ているのかを決定的にする。

## 4. 「誰に見えるか」を可変の状態から毎回計算し直さない

配信済みの通知の宛先をアサイン状況から都度計算していたため、担当を外すだけで
過去の通知が消えていた。**送った/起きた時点の事実はスナップショットして保存する**
(`notification_recipients`)。現在の状態から導出してよいのは「今の権限」だけ。

## 5. 権限・可視範囲の仕様変更は黒崎の明示許可を取ってから

誰が何を見られる/編集できるかの変更は、無断でやらない (2026-07-19 に一度差し戻し済み)。

## 自己診断

`GET /api/internal/selfcheck` (管理者セッション) で上記の症状を実データに対して検査できる。
同じ検査を mcp-worker の cron が毎日 09:00 JST に走らせ、異常があれば管理者へ通知する。
検査は**本番のエクスポート済み関数をそのまま呼ぶ**こと。ここで SQL を書き直すと、
検査だけ通って本番が壊れたままになる。
