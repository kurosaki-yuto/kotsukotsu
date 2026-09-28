"use client";

import { useEffect, useRef, useState } from "react";

// ゴール詳細の「完了にする」の横に置く「AIで進める」プルダウン。
// Claude / Codex のデスクトップアプリを、このゴールの指示文入りで開く (送信は本人がアプリ側で Enter)。
// サービスページの「アプリで開く」と同じ URL を使う。
//   Claude: claude://code/new?q=...          (Claude Desktop の Code 画面)
//   Codex:  codex://threads/new?prompt=...   (Codex アプリ)
// claude.ai/code・chatgpt.com/codex は X-Frame-Options: SAMEORIGIN で埋め込めないため、別アプリで開く形にしている。

function promptFor(id: string, name: string): string {
  return [
    `こつこつのゴール「${name}」 (id: ${id}) を進めてください。`,
    "まずこつこつの get_goal・list_subtasks・list_comments で完了の基準と現状、最新のコメントを確認してください。",
    "そのうえで作業ステップを add_subtask で登録してから着手し、1つ終わるごとに complete_subtask してください。",
  ].join("\n");
}

const APPS = [
  { key: "codex", label: "Codex で進める", url: (q: string) => `codex://threads/new?prompt=${q}` },
  { key: "claude", label: "Claude Code で進める", url: (q: string) => `claude://code/new?q=${q}` },
] as const;

export default function AgentLaunch({ goalId, goalName }: { goalId: string; goalName: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const text = promptFor(goalId, goalName);
  const q = encodeURIComponent(text);
  // デスクトップアプリを開くリンクなので、スマホでは出さない
  return (
    <div ref={ref} className="relative hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12.5px] font-bold hover:bg-[var(--hover)] transition-colors"
        style={{ borderColor: "var(--border-strong)", color: "var(--foreground)", background: "var(--background)" }}
      >
        AIで進める
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 z-20 min-w-[200px] card py-1" style={{ boxShadow: "var(--shadow-pop)" }}>
          {APPS.map((a) => (
            <a
              key={a.key}
              role="menuitem"
              href={a.url(q)}
              onClick={() => { try { navigator.clipboard.writeText(text); } catch {} setOpen(false); }}
              className="block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]"
            >
              {a.label}
            </a>
          ))}
          <div className="px-4 pt-1 pb-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            指示文を入れた状態でアプリが開きます
          </div>
        </div>
      )}
    </div>
  );
}
