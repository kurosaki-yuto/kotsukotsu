import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppShell from "./components/AppShell";
import PWARegister from "./components/PWARegister";

export const metadata: Metadata = {
  title: "こつこつ",
  description: "コツれば終わる",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "こつこつ", statusBarStyle: "default" },
  // .ico も置いてあるのは、/favicon.ico だけを見に来る外部クローラ
  // (claude.ai のコネクタ一覧など) に SVG が届かないため。
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon.svg", type: "image/svg+xml" },
      // Google のファビコンは 48px の倍数以上を求める。claude.ai のコネクタ一覧は
      // Google のファビコン (s2) を出すので、PNG の大きいものも明示しておく。
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#1d3b9e",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-full cjk">
        <PWARegister />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
