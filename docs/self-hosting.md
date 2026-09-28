# 自分の環境でこつこつを立ち上げる

こつこつは **使う会社・人がそれぞれ自分のデータベースとデプロイ先を作って動かす** 設計になっている。
このリポジトリにはデータベースもデプロイ先も入っておらず、共有のサーバーもない。
データベース・Worker・シークレットは、すべて自分の Cloudflare アカウントに作る。

作るのは `npm run setup` が1回でやる。Claude Code などの AI に「立ち上げて」と頼めば、
`AGENTS.md` の手順どおりに AI が進める。

## いちばん早い立ち上げ方 (10 分)

用意するもの:

- Node.js 20 以上
- Cloudflare アカウント (無料プランでよい。<https://dash.cloudflare.com/sign-up>)
- 名前をひとつ決める。会社やチームごとの名前で、Worker・データベースの名前の元になる
  (英小文字・数字・ハイフン。例: `acme-kotsukotsu`)

```bash
git clone https://github.com/kurosaki-yuto/kotsukotsu.git
cd kotsukotsu
npm install
npm run setup -- --name acme-kotsukotsu
```

途中でブラウザが開いたら Cloudflare にログインして許可する。終わると次のように URL が出る。

```
✓ できました

  こつこつ     https://acme-kotsukotsu.<あなたのサブドメイン>.workers.dev
  AI 接続 (MCP) https://acme-kotsukotsu-mcp.<あなたのサブドメイン>.workers.dev/mcp
```

1. こつこつの URL を開き「新規登録」から最初のアカウントを作る。登録した人がワークスペースの管理者になる
2. 仲間は 設定 → 招待リンク から招く
3. Claude から使うときは 設定 → APIキー の接続 URL を claude.ai のコネクタ (カスタムコネクタ) に貼る

### `npm run setup` がやること

`<名前>` は `--name` で渡した名前。

| 順番 | やること |
|---|---|
| 1 | Cloudflare にログインしているか確かめる。していなければ `wrangler login` を開く。アカウントが複数あれば選ばせる (`--account <ID>` でも指定できる) |
| 2 | `<名前>` の Worker・データベース・バケットがアカウントに既に無いか確かめる。**あれば上書きせずに止まる** |
| 3 | D1 データベース `<名前>-db` を作り、`d1-migrations/` のテーブルを全部作る |
| 4 | R2 バケット `<名前>-files` を作る (ファイル添付用。下の注意を参照) |
| 5 | 鍵とシークレットを作る (Web Push の鍵、Worker 間の合言葉、MCP の鍵) |
| 6 | リアルタイム `<名前>-rt` → 本体 `<名前>` → MCP `<名前>-mcp` の順にデプロイし、シークレットを入れる |
| 7 | 設定ファイルの目印 (`your-app-name` / `YOUR_SUBDOMAIN` など) を自分の値に書き換える |

- 何度実行してもよい。2 回目以降は `--name` を省いても、作ったものを使い回してデプロイし直すだけになる。
  **アップデートを取り込んだあとも `npm run setup` でよい**
- 同じ Cloudflare アカウントに、名前を変えていくつでも別の環境を作れる (リポジトリは環境ごとに clone する)
- 生成したシークレットと名前は `.setup.json` に保存される (`.gitignore` 済み)。消すと次回に別の値が作られる
- ローカル開発用の `.dev.vars` と `mcp-worker/.dev.vars` も同じ値で作る

### 料金

Workers・D1・Durable Object はどれも無料プランの範囲で動く (本体の Worker は圧縮後 約 1.2MB で、無料プランの上限 3MB に収まる)。

R2 は Cloudflare ダッシュボードで一度「有効化」しないと使えない (無料枠あり。有効化にはカードの登録が要る)。
**有効化していなくても setup は止まらず、ファイル添付だけが使えない状態で立ち上がる。**
あとから使うときは R2 を有効化し、`.setup.json` の `"r2": false` の行を消して `npm run setup` をもう一度実行する。

### 提供元に送るもの

`npm run setup` が最後まで終わったときだけ、提供元 (合同会社もちもつ) に「1件立ち上がった」ことを知らせる。
何社で使われているかを数えるためのもので、送るのは次の2つだけ。

- `.setup.json` にある乱数の ID (環境ごとに1つ。会社や人は特定できない)
- プログラムの版 (git のコミット番号)

会社名・URL・メールアドレス・こつこつに入れたデータは送らない。送りたくないときは
`npm run setup -- --name <名前> --no-telemetry` のように `--no-telemetry` を付けるか、
環境変数 `KOTSUKOTSU_NO_TELEMETRY=1` を設定する。

## 全体像

| Worker | ディレクトリ | 役割 |
|---|---|---|
| `<名前>` | リポジトリ直下 | 画面・API・ログイン (Next.js + OpenNext) |
| `<名前>-rt` | `realtime-worker/` | リアルタイム更新 (Durable Object + WebSocket) |
| `<名前>-mcp` | `mcp-worker/` | Claude などの AI から操作する MCP サーバー。期限リマインダの Cron も持つ |

本体と MCP は同じ D1 と R2 を共有する。Worker 同士は service binding でつなぐ
(同じアカウントの `*.workers.dev` 同士の fetch は Cloudflare に塞がれるため)。

## あとから足せるもの

| 何を | どうする |
|---|---|
| パスワード再設定メール | [Resend](https://resend.com) の API キーを取り、`npx wrangler secret put RESEND_API_KEY` と `npx wrangler secret put MAIL_FROM` (例: `こつこつ <noreply@example.com>`)。未設定なら再設定メールを送らない |
| 独自ドメイン | Cloudflare ダッシュボードで `<名前>` Worker にカスタムドメインを付ける。リアルタイムと MCP は workers.dev のまま使われる |

## アップデートを取り込む

公開リポジトリは随時更新される。取り込むときは、立ち上げたフォルダで次の2つを実行する。
AI に「こつこつを最新にして」と頼んでもよい。

```bash
git pull
npm install && npm run setup
```

`npm run setup` は作ったものを使い回し、テーブルの追加 (マイグレーション) と再デプロイだけを行う。
データは消えない。

## ローカルで動かす

`npm run setup` を一度実行していれば `.dev.vars` ができている。

```bash
npm run cf:typegen
npm run cf:migrate:local
npm run dev    # http://localhost:3939
```

## 消すとき

データも消える。元に戻せない。`<名前>` は `.setup.json` の `"name"`。

```bash
npx wrangler delete --name <名前>-mcp
npx wrangler delete --name <名前>
npx wrangler delete --name <名前>-rt
npx wrangler d1 delete <名前>-db
npx wrangler r2 bucket delete <名前>-files   # 中身が空のときだけ消せる
```

## 困ったとき

- `Worker「…」が既にこのアカウントにあります`: 同じ名前の環境が既にある。別の名前で `npm run setup -- --name <別の名前>` を実行する
- `workers.dev のサブドメインが分かりませんでした`: 初めて Workers を使うアカウントは、ダッシュボードの Workers & Pages でサブドメインを登録してから再実行する
- `wrangler.jsonc は別の環境の設定になっています`: 別の環境用に書き換わったリポジトリで実行しようとしている。新しい環境を作るなら、公開リポジトリを別のフォルダに clone し直す
- 画面は出るがデータが空: 本体と MCP の `database_id` が同じか確認する
- 他の端末に即時反映されない: 3 つの Worker の `RT_SECRET` が同じ値か確認する (15 秒ごとの再取得には戻る)
- スマホに通知が来ない: `wrangler.jsonc` の `VAPID_PUBLIC_KEY` と `.setup.json` の `VAPID_PRIVATE_KEY` が同じ組か確認する

## 手で立ち上げる場合

`npm run setup` を使わずに進めるときの対応表。

| シークレット | `<名前>` | `<名前>-rt` | `<名前>-mcp` | 用途 |
|---|:-:|:-:|:-:|---|
| `RT_SECRET` | 要 | 要 | 要 | リアルタイム配信の認証 (3 つとも同じ値) |
| `PUSH_SECRET` | 要 | | 要 | MCP から本体の Push 送信を呼ぶ認証 (同じ値) |
| `VAPID_PRIVATE_KEY` | 要 | | | Web Push の署名 |
| `MCP_TOKEN` | | | 要 | 管理者用の固定 MCP トークン |
| `OAUTH_SECRET` | | | 要 | claude.ai コネクタの OAuth 用の暗号鍵 |

1. `your-app-name` を自分で決めた名前に置き換える (`wrangler.jsonc`・`mcp-worker/wrangler.jsonc`・`realtime-worker/wrangler.jsonc`・`app/lib/hosts.ts`・`mcp-worker/src/index.ts`・`package.json`)
2. `npx wrangler d1 create <名前>-db` の `database_id` を `wrangler.jsonc` と `mcp-worker/wrangler.jsonc` の `YOUR_D1_DATABASE_ID` に貼る
3. `npx wrangler d1 migrations apply <名前>-db --remote`
4. `npx wrangler r2 bucket create <名前>-files` (使わないなら両 `wrangler.jsonc` の `FILES` の行を消す)
5. `npx web-push generate-vapid-keys` の公開鍵を `wrangler.jsonc` の `VAPID_PUBLIC_KEY` に、`VAPID_SUBJECT` を自分の `mailto:` に
6. `YOUR_SUBDOMAIN` を自分の workers.dev サブドメインに置き換える (手順 1 と同じファイル)
7. デプロイ: `npx wrangler deploy --config realtime-worker/wrangler.jsonc` → `npm run cf:typegen && npm run cf:deploy` → `npx wrangler deploy --config mcp-worker/wrangler.jsonc`
8. 上の表のシークレットを `npx wrangler secret put <NAME> --config <各 wrangler.jsonc>` で入れる
