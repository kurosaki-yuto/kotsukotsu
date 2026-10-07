import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "こつこつ",
    short_name: "こつこつ",
    description: "コツれば終わる",
    // ?source=pwa は「アプリとして開いた」印。kotukotu.app の入口 (pages-proxy) が、
    // ログインしていないときにサービス紹介ページではなくログイン画面へ回すのに使う。
    start_url: "/?source=pwa",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#1d3b9e",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
