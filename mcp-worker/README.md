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
| `list_goals` | Non-archived projects, ordered by `order_idx` |
| `get_goal` | One project by `id` |
| `create_goal` | Insert project (`order_idx` = max+1) |
| `update_goal` | Patch `name` / `current_state` / `completion_criteria` / `deadline` / `status` |
| `list_subtasks` | Nodes for a goal, ordered by `order_idx` |
| `add_subtask` | Insert node (`order_idx` = max+1 among siblings; optional `parentId`) |
| `complete_subtask` | Set/clear `completed_at` |
| `list_today` | Nodes where `today_date = ?` (default today, UTC) joined with project name |
| `set_today` | Set/clear a node's `today_date` (`date: null` clears) |
| `send_chat` | Insert `chat_messages` — **this is how Addy replies in-app** (role defaults `addy`, author `Addy`) |
| `list_resources` | Resources for a goal |
| `create_notification` | Insert notification (`kind` defaults `info`) |

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
