import Link from "next/link";
import type * as React from "react";

// 公開ページ /column の外枠。ログインしていない人も読む (AppShell の外。isPublicPage 参照)。
// 色と字組みは紹介ページ (public/introduction.html) に合わせる。
export default function ColumnFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: "#fff", color: "#18233d" }}>
      <header className="border-b" style={{ borderColor: "#dce2ee" }}>
        <div className="mx-auto flex h-16 w-full max-w-[880px] items-center justify-between px-4 md:px-6">
          <a href="/" className="flex items-center gap-2 text-[17px] font-bold" style={{ color: "#1d3b9e" }} aria-label="こつこつ トップ">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 4C11 4 4 11 4 20M20 4c0 7-5 13-12 14H4v-4M14 8l-7 7" />
            </svg>
            こつこつ
          </a>
          <nav className="flex items-center gap-4 text-[13.5px] font-medium">
            <Link href="/column" style={{ color: "#60697b" }}>コラム</Link>
            <a href="/login" className="rounded-full px-3.5 py-1.5 font-bold text-white" style={{ background: "#1d3b9e" }}>ログイン</a>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[880px] px-4 py-10 md:px-6 md:py-14">{children}</main>
      <footer className="border-t py-8 text-center text-[12px]" style={{ borderColor: "#dce2ee", color: "#60697b" }}>
        <a href="/" className="underline underline-offset-2">こつこつ</a> — コツれば終わる
      </footer>
    </div>
  );
}
