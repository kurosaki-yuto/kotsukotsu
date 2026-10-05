"use client";

import { useEffect, useState } from "react";

// タスク画面のカード (あなたの番・終えたタスク・期限が近い) を見出しで開け閉めする。閉じたかどうかは端末に覚える。
// まだ一度も触っていないときは、phoneClosed のカードだけスマホ幅で閉じた状態から始める (画面が狭く、ツリーが下に押し出されるため)。
export function useCollapsed(key: string, phoneClosed = false) {
  const storageKey = `kk:collapse:${key}`;
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v !== null) setClosed(v === "1");
      else if (phoneClosed && window.matchMedia("(max-width: 767px)").matches) setClosed(true);
    } catch { /* private mode など。開いたままにする */ }
  }, [storageKey, phoneClosed]);
  const toggle = () =>
    setClosed((c) => {
      const next = !c;
      try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* 覚えられなくても開け閉めはできる */ }
      return next;
    });
  return [closed, toggle] as const;
}

export function Chevron({ closed }: { closed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={{ transform: closed ? "rotate(-90deg)" : undefined, transition: "transform .15s" }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
