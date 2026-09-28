// 本体・リアルタイム・MCP の Worker の名前と、動いている workers.dev のサブドメイン。
// Worker 名は APP_NAME / APP_NAME-rt / APP_NAME-mcp。
// セルフホストでは npm run setup が自分で決めた名前とアカウントの値に書き換える。
export const APP_NAME = "your-app-name";
export const WORKERS_DEV = "YOUR_SUBDOMAIN.workers.dev";

export const RT_HOST = `${APP_NAME}-rt.${WORKERS_DEV}`;
export const MCP_HOST = `${APP_NAME}-mcp.${WORKERS_DEV}`;

// AI 接続先の案内。当社のホスト版 (kotukotu.app) だけは全員共通の URL でログインして繋げる。
// 自社専用版はそれぞれの MCP にキー入り URL で繋ぐので、設定画面の場所を案内する。
// (当社の URL を自社専用版の人に案内すると、よその会社のデータの入口に誘導することになる)
export const OFFICIAL_MCP_URL = "https://mcp.kotukotu.app/mcp";

export function isOfficialHost(host: string): boolean {
  return host === "kotukotu.app" || host.endsWith(".kotukotu.app");
}

export function mcpConnectHint(): string {
  const host = typeof window === "undefined" ? "" : window.location.host;
  return isOfficialHost(host)
    ? `${OFFICIAL_MCP_URL} を追加してログインしてください`
    : "こつこつの 設定 → APIキー にある接続用URLを追加してください";
}
