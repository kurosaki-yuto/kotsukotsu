-- API key (MCP bearer token) stored in org_settings, manageable from 設定 > APIキー.
ALTER TABLE org_settings ADD COLUMN mcp_token TEXT;
