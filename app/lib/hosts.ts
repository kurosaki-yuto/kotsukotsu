// 本体・リアルタイム・MCP の Worker の名前と、動いている workers.dev のサブドメイン。
// Worker 名は APP_NAME / APP_NAME-rt / APP_NAME-mcp。
// セルフホストでは npm run setup が自分で決めた名前とアカウントの値に書き換える。
export const APP_NAME = "your-app-name";
export const WORKERS_DEV = "YOUR_SUBDOMAIN.workers.dev";

export const RT_HOST = `${APP_NAME}-rt.${WORKERS_DEV}`;
export const MCP_HOST = `${APP_NAME}-mcp.${WORKERS_DEV}`;
