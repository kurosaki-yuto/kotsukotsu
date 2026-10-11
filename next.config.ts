import type { NextConfig } from "next";

// どの画面・API にも付けるセキュリティ用のヘッダー。
// - 他サイトの iframe に埋め込ませない (クリックジャッキング対策)
// - 送られてきたファイルの種類を推測させない
// - 外部サイトへ移るときに URL の中身 (ゴール id など) を渡さない
// - HTTPS 以外で開かせない
// - カメラ・マイク・位置情報は使わないので、埋め込まれた何かにも使わせない
//
// CSP: 外のスクリプトは読まない。Next のハイドレーション用のインラインスクリプトがあるので script-src に
// 'unsafe-inline' は要る (nonce 化は OpenNext 経由だと静的ページで崩れるため今は入れない)。それでも
// 外部ドメインへの読み込み・送信、object の埋め込み、他サイトからの iframe 埋め込み、<base> の差し替えは止まる。
// 開発中 (next dev) は eval を使うので 'unsafe-eval' を足す。
const DEV = process.env.NODE_ENV !== "production";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  // 開発中は手元の MCP (localhost:8788 など) も叩けるようにする
  "connect-src 'self' https: wss:" + (DEV ? " ws: http://localhost:* http://127.0.0.1:*" : ""),
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");
const SECURITY_HEADERS = [
  // 自分のページ (PDF の同一オリジンプレビュー) だけ iframe に入れてよい。他サイトは不可
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Content-Security-Policy", value: CSP },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig: NextConfig = {
  async headers() {
    // 添付ファイルとアバターの応答は、ページ用の CSP ではなく sandbox にする (後に書いた方が勝つ)。
    // 万一スクリプト入りのファイルが混ざっても、本体の cookie・ストレージ・親ページには触れない。
    const FILE_CSP = { key: "Content-Security-Policy", value: "sandbox; default-src 'none'; style-src 'unsafe-inline'" };
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/files", headers: [FILE_CSP] },
      { source: "/api/members/:id/avatar", headers: [FILE_CSP] },
    ];
  },
};

export default nextConfig;

// OpenNext Cloudflare: makes the D1 binding available during `next dev`.
// Docker 版 (KOTSUKOTSU_RUNTIME=node) は Cloudflare を使わないので呼ばない。
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.KOTSUKOTSU_RUNTIME !== "node") initOpenNextCloudflareForDev();
