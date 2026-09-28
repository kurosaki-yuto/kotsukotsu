<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

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
