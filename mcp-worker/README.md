# kotsukotsu-mcp

Remote **MCP server** (Cloudflare Worker) that lets an AI — Claude — operate the
Addness todo app. Its tools run SQL directly against the **same Cloudflare D1
database** as the main app (binding `DB`, `database_name: "kotsukotsu-db"`).

- **Transport:** MCP **Streamable HTTP**, implemented statelessly in the Worker
  `fetch` handler (one JSON-RPC request per `POST` → one JSON response). No
  Durable Objects required. Tool input schemas are authored with **zod** and
  converted to JSON Schema with **zod-to-json-schema**.
- **Endpoint:** `POST /mcp` (auth required) · `GET /health` (no auth → `{ ok: true }`)
- **Auth:** `Authorization: Bearer <MCP_TOKEN>` (Worker secret, constant-time compare).
  Missing/wrong → `401`.

## Tools

| Tool | Description |
|------|-------------|
| `list_goals` | 未アーカイブのゴール (タスク) 一覧。`order_idx` 順、`limit`/`offset` でページング |
| `get_goal` | 1件。完了の基準・現状に加え、直下のタスクの進み具合 (`task_progress`)・現状が古いか (`current_state_is_stale`)・似た仕事の前例 (`precedents`) を返す |
| `create_goal` | ゴールを作る。`completion_criteria` / `current_state` もその場で書ける |
| `update_goal` | 名前・完了の基準・現状・期限・状態を部分更新 |
| `move_goal` | 親の付け替え・並べ替え |
| `list_subtasks` | 直下のタスク一覧 |
| `add_subtask` | 小タスクを作る。`completion_criteria` (何ができたら終わりか) と `current_state` も渡せる。作った本人が担当になる |
| `start_task` | 一番下の小タスクを「進行中」にする (誰の・どの AI か)。`started: false` で取り消し |
| `complete_subtask` | 完了 / 未完了に戻す。`current_state` に結果を渡すとその小タスクの現状に残る。親を完了すると配下も完了 |
| `record_playbook` | 終えたタスクのやり方を「型」として残す (似たタスクの前例として全員の AI に渡る) |
| `list_my_tasks` | 自分 (または `member` に名前・メールで指定したメンバー) の未完了の一番下のタスクを、今日 → 期限切れ → 進行中 → 3日以内 → その他 の順で返す |
| `list_today` / `set_today` | 今日やるものの一覧 / 日付の付け外し |
| `send_chat` / `edit_chat` / `delete_chat` / `list_comments` | ゴールのコメント。`@表示名` / `@全員` でメンション通知 |
| `list_resources` / `upload_file` | リソース (リンク・ファイル) |
| `create_notification` / `list_notifications` | 通知 |
| `list_members` / `assign_member_to_goal` / `unassign_member_from_goal` / `set_member_role` / `create_invite` | メンバーと担当・招待 |

All inputs are validated with zod; each tool returns the affected row(s) as JSON
text content.

## Setup & deploy

> Requires the same Cloudflare account that owns the main app's D1.

1. **Install** deps:
   ```bash
   npm install
   ```

2. **Point at the real D1.** Open `wrangler.jsonc` and replace
   `"database_id": "REPLACE_AFTER_D1_CREATE"` with the actual id of the
   `kotsukotsu-db` database (it must match the main app's `wrangler.jsonc`):
   ```bash
   wrangler d1 list          # find the id of kotsukotsu-db
   ```
   Paste that id into `d1_databases[0].database_id`.

3. **Set the auth secret** (this is `env.MCP_TOKEN`; pick a long random string):
   ```bash
   wrangler secret put MCP_TOKEN
   # paste your token when prompted
   ```
   For local `wrangler dev`, put it in a `.dev.vars` file instead:
   ```
   MCP_TOKEN=your-long-random-token
   ```

4. **Deploy:**
   ```bash
   npm run deploy        # = wrangler deploy
   ```
   The Worker is published at
   `https://kotsukotsu-mcp.<your-subdomain>.workers.dev`.

5. **Smoke test:**
   ```bash
   curl https://kotsukotsu-mcp.<your-subdomain>.workers.dev/health
   # -> {"ok":true}

   curl -X POST https://kotsukotsu-mcp.<your-subdomain>.workers.dev/mcp \
     -H "Authorization: Bearer $MCP_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

## Connect Claude to this MCP server

Add a remote MCP server entry pointing at `/mcp` with the Bearer token.

**Claude Desktop / `claude_desktop_config.json` (or `~/.claude.json` for the CLI):**
```json
{
  "mcpServers": {
    "addness-todo": {
      "type": "http",
      "url": "https://kotsukotsu-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

**Claude Code CLI (one-liner):**
```bash
claude mcp add --transport http addness-todo \
  https://kotsukotsu-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

Replace `<your-subdomain>` with your `workers.dev` subdomain and `YOUR_MCP_TOKEN`
with the secret you set in step 3.

## Notes

- The Worker is **stateless** — `GET /mcp` (server-initiated SSE) returns `405`
  because nothing is pushed; all interaction is request/response over `POST`.
- `complete_subtask({ completed: false })` reopens a task (clears `completed_at`).
- `set_today({ date: null })` unschedules a node.
- Never commit `.dev.vars` or the token — keep `MCP_TOKEN` as a Worker secret.
