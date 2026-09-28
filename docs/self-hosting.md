# 自分の環境でこつこつを立ち上げる

こつこつは **使う人がそれぞれ自分のデプロイ先を作って動かす** 設計になっている。
このリポジトリにはデータベースもデプロイ先も入っておらず、共有のサーバーもない。
データベース・Worker・シークレットは、すべて自分の Cloudflare アカウントに作る。

作るのは `npm run setup` が1回でやる。

## いちばん早い立ち上げ方 (10 分)

用意するもの:

- Node.js 20 以上
- Cloudflare アカウント (無料プランでよい。<https://dash.cloudflare.com/sign-up>)

```bash
git clone https://github.com/kurosaki-yuto/kotsukotsu.git
cd kotsukotsu
npm install
npm run setup
```

途中でブラウザが開いたら Cloudflare にログインして許可する。終わると次のように URL が出る。

```
✓ できました

  こつこつ     https://kotsukotsu.<あなたのサブドメイン>.workers.dev
  AI 接続 (MCP) https://kotsukotsu-mcp.<あなたのサブドメイン>.workers.dev/mcp
```

1. こつこつの URL を開き「新規登録」から最初のアカウントを作る。登録した人がワークスペースの管理者になる
2. 仲間は 設定 → 招待リンク から招く
3. Claude から使うときは 設定 → APIキー の接続 URL を claude.ai のコネクタ (カスタムコネクタ) に貼る

### `npm run setup` がやること

| 順番 | やること |
|---|---|
| 1 | Cloudflare にログインしているか確かめる。していなければ `wrangler login` を開く。アカウントが複数あれば選ばせる |
| 2 | D1 データベース `kotsukotsu-db` を作り、`d1-migrations/` のテーブルを全部作る |
| 3 | R2 バケット `kotsukotsu-files` を作る (ファイル添付用。下の注意を参照) |
| 4 | 鍵とシークレットを作る (Web Push の鍵、Worker 間の合言葉、MCP の鍵) |
| 5 | リアルタイム → 本体 → MCP の順に 3 つの Worker をデプロイし、シークレットを入れる |
| 6 | 設定ファイルの目印 (`YOUR_SUBDOMAIN` など) を自分の値に書き換える |

- 何度実行してもよい。2 回目以降は作ったものを使い回し、コードの変更をデプロイし直すだけになる。**アップデートを取り込んだあとも `npm run setup` でよい**
- 生成したシークレットは `.setup.json` に保存される (`.gitignore` 済み)。消すと次回に別の値が作られ、ログイン中の端末の再接続などが必要になる
- ローカル開発用の `.dev.vars` と `mcp-worker/.dev.vars` も同じ値で作る

### 料金

Workers・D1・Durable Object はどれも無料プランの範囲で動く (本体の Worker は圧縮後 約 1.2MB で、無料プランの上限 3MB に収まる)。

R2 は Cloudflare ダッシュボードで一度「有効化」しないと使えない (無料枠あり。有効化にはカードの登録が要る)。
**有効化していなくても setup は止まらず、ファイル添付だけが使えない状態で立ち上がる。**
あとから使うときは R2 を有効化し、`.setup.json` の `"r2": false` の行を消して `npm run setup` をもう一度実行する。

## 全体像

| Worker | ディレクトリ | 役割 |
|---|---|---|
| `kotsukotsu` | リポジトリ直下 | 画面・API・ログイン (Next.js + OpenNext) |
| `kotsukotsu-rt` | `realtime-worker/` | リアルタイム更新 (Durable Object + WebSocket) |
| `kotsukotsu-mcp` | `mcp-worker/` | Claude などの AI から操作する MCP サーバー。期限リマインダの Cron も持つ |

本体と MCP は同じ D1 と R2 を共有する。Worker 同士は service binding でつなぐ
(同じアカウントの `*.workers.dev` 同士の fetch は Cloudflare に塞がれるため)。

## あとから足せるもの

| 何を | どうする |
|---|---|
| パスワード再設定メール | [Resend](https://resend.com) の API キーを取り、`npx wrangler secret put RESEND_API_KEY` と `npx wrangler secret put MAIL_FROM` (例: `こつこつ <noreply@example.com>`)。未設定なら再設定メールを送らない |
| 独自ドメイン | Cloudflare ダッシュボードで `kotsukotsu` Worker にカスタムドメインを付ける。リアルタイムと MCP は workers.dev のまま使われる |

## ローカルで動かす

`npm run setup` を一度実行していれば `.dev.vars` ができている。

```bash
npm run cf:typegen
npm run cf:migrate:local
npm run dev    # http://localhost:3939
```

## 消すとき

データも消える。元に戻せない。

```bash
npx wrangler delete --name kotsukotsu-mcp
npx wrangler delete --name kotsukotsu
npx wrangler delete --name kotsukotsu-rt
npx wrangler d1 delete kotsukotsu-db
npx wrangler r2 bucket delete kotsukotsu-files   # 中身が空のときだけ消せる
```

## 困ったとき

- `workers.dev のサブドメインが分かりませんでした`: 初めて Workers を使うアカウントは、ダッシュボードの Workers & Pages でサブドメインを登録してから再実行する
- `wrangler.jsonc は既に設定済みです`: 別の環境の値が入った設定で実行しようとしている。自分の環境で作り直すなら、`git checkout wrangler.jsonc mcp-worker/wrangler.jsonc app/lib/hosts.ts mcp-worker/src/index.ts` で目印に戻してから実行する
- 画面は出るがデータが空: 本体と MCP の `database_id` が同じか確認する
- 他の端末に即時反映されない: 3 つの Worker の `RT_SECRET` が同じ値か確認する (15 秒ごとの再取得には戻る)
- スマホに通知が来ない: `wrangler.jsonc` の `VAPID_PUBLIC_KEY` と `.setup.json` の `VAPID_PRIVATE_KEY` が同じ組か確認する

## 手で立ち上げる場合

`npm run setup` を使わずに進めるときの対応表。

| シークレット | kotsukotsu | kotsukotsu-rt | kotsukotsu-mcp | 用途 |
|---|:-:|:-:|:-:|---|
| `RT_SECRET` | 要 | 要 | 要 | リアルタイム配信の認証 (3 つとも同じ値) |
| `PUSH_SECRET` | 要 | | 要 | MCP から本体の Push 送信を呼ぶ認証 (同じ値) |
| `VAPID_PRIVATE_KEY` | 要 | | | Web Push の署名 |
| `MCP_TOKEN` | | | 要 | 管理者用の固定 MCP トークン |
| `OAUTH_SECRET` | | | 要 | claude.ai コネクタの OAuth 用の暗号鍵 |

1. `npx wrangler d1 create kotsukotsu-db` の `database_id` を `wrangler.jsonc` と `mcp-worker/wrangler.jsonc` の `YOUR_D1_DATABASE_ID` に貼る
2. `npx wrangler d1 migrations apply kotsukotsu-db --remote`
3. `npx wrangler r2 bucket create kotsukotsu-files` (使わないなら両 `wrangler.jsonc` の `FILES` の行を消す)
4. `npx web-push generate-vapid-keys` の公開鍵を `wrangler.jsonc` の `VAPID_PUBLIC_KEY` に、`VAPID_SUBJECT` を自分の `mailto:` に
5. `YOUR_SUBDOMAIN` を自分の workers.dev サブドメインに置き換える (`wrangler.jsonc`・`mcp-worker/wrangler.jsonc`・`app/lib/hosts.ts`・`mcp-worker/src/index.ts`)
6. デプロイ: `npx wrangler deploy --config realtime-worker/wrangler.jsonc` → `npm run cf:typegen && npm run cf:deploy` → `npx wrangler deploy --config mcp-worker/wrangler.jsonc`
7. 上の表のシークレットを `npx wrangler secret put <NAME> --config <各 wrangler.jsonc>` で入れる
