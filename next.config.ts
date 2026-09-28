import type { NextConfig } from "next";

// どの画面・API にも付けるセキュリティ用のヘッダー。
// - 他サイトの iframe に埋め込ませない (クリックジャッキング対策)
// - 送られてきたファイルの種類を推測させない
// - 外部サイトへ移るときに URL の中身 (ゴール id など) を渡さない
// - HTTPS 以外で開かせない
// - カメラ・マイク・位置情報は使わないので、埋め込まれた何かにも使わせない
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

// OpenNext Cloudflare: makes the D1 binding available during `next dev`.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
