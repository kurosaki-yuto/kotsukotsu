# Docker でこつこつを立ち上げる (Cloudflare を使わない版)

Cloudflare を使わず、**Docker が動く所ならどこでも**自社専用のこつこつを立ち上げられる。
AWS (Lightsail・EC2)、Google Cloud (Compute Engine)、Azure、さくら・ConoHa などの VPS、社内のサーバー、手元のパソコン、どれでも同じ手順で動く。

Cloudflare で立てる場合は [self-hosting.md](./self-hosting.md)。機能はどちらも同じ。

Claude Code などの AI に「立ち上げて」と頼めば、`AGENTS.md` の手順どおりに AI が進める (Cloudflare か Docker かを最初に聞かれる)。

## 用意するもの

- Docker (Docker Desktop か Docker Engine。`docker compose` が使えること)
- Node.js 20 以上 (立ち上げ・更新のスクリプトを動かすのに使う)
- 社外から使う場合: サーバー1台 (目安: メモリ 1GB 以上) と、独自ドメイン1つ

## 立ち上げる

### 手元のパソコンで試す・社内の1台だけで使う

```bash
git clone https://github.com/kurosaki-yuto/kotsukotsu.git
cd kotsukotsu
npm run setup:docker
```

終わると `http://localhost:3000` が出る。このパソコンからだけ開ける。

### サーバーに置いて、みんなで使う (HTTPS)

1. サーバーを1台用意して Docker を入れる
2. 使うドメイン (例: `tasks.example.com`) の DNS に、サーバーの IP を指す A レコードを作る
3. サーバーの 80 番と 443 番を開ける
4. サーバーで次を実行する

```bash
git clone https://github.com/kurosaki-yuto/kotsukotsu.git
cd kotsukotsu
npm run setup:docker -- --domain tasks.example.com
```

証明書 (Let's Encrypt) は自動で取られ、`https://tasks.example.com` で開けるようになる。

### そのあと

1. URL を開いて「新規登録」から最初のアカウントを作る (その人が管理者になる)
2. 仲間は 設定 → 招待リンク から招く (2人目以降は招待リンクからしか登録できない)
3. Claude から使うときは 設定 → APIキー の接続 URL を claude.ai のコネクタに貼る

## 中で何が動いているか

| 部品 | Docker 版 | (参考) Cloudflare 版 |
|---|---|---|
| 画面・API | Next.js | Workers (OpenNext) |
| データベース | SQLite ファイル (`kotsukotsu-data` ボリュームの `kotsukotsu.sqlite`) | D1 |
| 添付ファイル | 同じボリュームの `files/` | R2 |
| リアルタイム更新 | 同じサーバーの `/ws` | Durable Object |
| AI 接続 (MCP) | 同じサーバーの `/mcp` | 別の Worker |
| 期限リマインダ | 5 分ごとのタイマー | Cron |
| HTTPS | Caddy (`--domain` のとき) | Cloudflare |

全部を 1 つのコンテナ (`kotsukotsu`) が受け持つ。データはボリューム `kotsukotsu-data` にあり、コンテナを作り直しても消えない。
設定と鍵は `.env` (`.gitignore` 済み)。なくさない・共有しない。

## 新しい機能を取り込む

```bash
npm run update
```

`git pull` → データベースを丸ごとバックアップ (`backups/kotsukotsu-<日時>.sqlite`) → 作り直して起動、の順に進む。
起動したときに、まだ入っていないテーブル追加だけが当たる。データは消えない。自分で書き換えたファイルがあれば止まる。

### 更新前に戻したいとき

```bash
npm run restore                                    # 一番新しいバックアップに戻す
npm run restore -- backups/kotsukotsu-<日時>.sqlite  # 指定したバックアップに戻す
```

戻す前の今のデータも `backups/before-restore-<日時>.sqlite` に残る。

## よく使う操作

```bash
docker compose ps                  # 動いているか
docker compose logs -f kotsukotsu  # ログ
docker compose restart kotsukotsu  # 再起動
```

## 消すとき

データも消える。元に戻せない。

```bash
docker compose --profile https down -v
```

## 困ったとき

- ログインしてもすぐログイン画面に戻る: HTTPS でないと、ログインの Cookie が保存されない (`localhost` は例外)。サーバーでは `--domain` を付けて HTTPS にする
- `--domain` で証明書が取れない: DNS の A レコードがサーバーの IP を向いているか、80・443 番が開いているかを確かめる (`docker compose logs caddy`)
- 他の端末に即時反映されない: リバースプロキシを自分で立てている場合は `/ws` の WebSocket を通す設定にする (Caddy は何もしなくてよい)
