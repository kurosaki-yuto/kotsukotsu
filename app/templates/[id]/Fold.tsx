"use client";

import { useEffect, useState, type ReactNode } from "react";

const KEY = "kk:tpl:fold:";

// 型の画面の区画。見出しを押すと閉じる/開く (11/3 黒崎「型のところトグルで開閉」)。
// 開閉は区画ごとに端末に覚える (全部の型で共通)。右の「+ 足す」を押したときは開く。
export function Fold({
  id,
  title,
  actions,
  defaultOpen = true,
  className = "card px-5 py-4",
  children,
}: {
  id: string;
  title: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY + id);
      if (v !== null) setOpen(v === "1");
    } catch { /* private mode */ }
  }, [id]);
  const set = (v: boolean) => {
    setOpen(v);
    try { localStorage.setItem(KEY + id, v ? "1" : "0"); } catch { /* private mode */ }
  };
  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => set(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-80"
        >
          <span style={{ display: "inline-flex", flex: "none", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} aria-hidden>
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor"><path d="M6 3l5 5-5 5V3z" /></svg>
          </span>
          <h2 className="min-w-0 text-[14px] font-bold break-words">{title}</h2>
        </button>
        {actions && <div className="shrink-0" onClickCapture={() => { if (!open) set(true); }}>{actions}</div>}
      </div>
      {open && children}
    </section>
  );
}
