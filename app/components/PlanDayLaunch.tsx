"use client";

import { useEffect, useRef, useState } from "react";
import { planDayPrompt, planTeamPrompt } from "../lib/planDay";

// タスク画面の「AIで今日の予定を組む」。こつこつのタスクと Google カレンダーの空きを AI に読ませて、
// 今日の予定を組ませる指示文を入れた状態で AI を開く (送信は本人)。指示文は lib/planDay.ts。
// カレンダーのコネクタがあるのは Claude なので、Claude (チャット) と Claude Code だけを出す。
//   Claude:      https://claude.ai/new?q=...   (入力欄に入った状態で開く。2026-10-05 確認)
//   Claude Code: claude://code/new?q=...       (Claude Desktop の Code 画面。PC のみ)

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default function PlanDayLaunch() {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState<"idle" | "ok" | "ng">("idle");
  // メンバーの分を組むときの名前 (読点・カンマ・スペース区切り)
  const [names, setNames] = useState("");
  const nameList = names.split(/[、,，\s　]+/).filter(Boolean);
  const teamText = planTeamPrompt(nameList, origin);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (!open) { setCopied("idle"); return; }
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const text = planDayPrompt(origin);
  const q = encodeURIComponent(text);
  const item = "block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]";
  const sub = "block text-[11px] mt-0.5";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="chip"
        title="こつこつのタスクを Google カレンダーの空き時間に入れる"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
        AIで今日の予定を組む
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 z-20 w-[min(300px,calc(100vw-48px))] card py-1" style={{ boxShadow: "var(--shadow-pop)" }}>
          <a role="menuitem" href={`https://claude.ai/new?q=${q}`} target="_blank" rel="noopener noreferrer" onClick={() => { void copyText(text); setOpen(false); }} className={item}>
            Claude で組む
            <span className={sub} style={{ color: "var(--muted)" }}>案を表で見せて、OK したらカレンダーに入れます</span>
          </a>
          <span className="hidden md:block">
            <a role="menuitem" href={`claude://code/new?q=${q}`} onClick={() => { void copyText(text); setOpen(false); }} className={item}>
              Claude Code で組む
              <span className={sub} style={{ color: "var(--muted)" }}>Claude のコネクタをそのまま使います</span>
            </a>
          </span>
          <button
            type="button"
            role="menuitem"
            onClick={async () => { const ok = await copyText(text); setCopied(ok ? "ok" : "ng"); if (ok) setTimeout(() => setOpen(false), 1200); }}
            className={`${item} border-t`}
            style={{ borderColor: "var(--border)" }}
          >
            {copied === "ok" ? "コピーしました" : "指示文をコピー"}
            <span className={sub} style={{ color: copied === "ng" ? "var(--danger)" : "var(--muted)" }}>
              {copied === "ng" ? "コピーできませんでした" : "開かずにコピーだけします"}
            </span>
          </button>
          <div className="border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <div className="text-sm">メンバーの予定を組む</div>
            <span className={sub} style={{ color: "var(--muted)" }}>名前を読点で区切って入れる (姓だけでも可)</span>
            <input
              value={names}
              onChange={(e) => setNames(e.target.value)}
              placeholder="例: 田中、松本、小西"
              className="mt-2 w-full rounded-[8px] border px-2.5 py-1.5 text-[13px] outline-none"
              style={{ borderColor: "var(--border-strong)" }}
            />
            <a
              role="menuitem"
              href={nameList.length ? `https://claude.ai/new?q=${encodeURIComponent(teamText)}` : undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!nameList.length}
              onClick={(e) => { if (!nameList.length) { e.preventDefault(); return; } void copyText(teamText); setOpen(false); }}
              className="mt-2 inline-block rounded-full px-3 py-1 text-[12.5px] font-bold text-white"
              style={{ background: nameList.length ? "var(--accent)" : "var(--muted-soft)", cursor: nameList.length ? "pointer" : "not-allowed" }}
            >
              Claude で{nameList.length ? ` ${nameList.length}人分を` : ""}組む
            </a>
          </div>
          <a role="menuitem" href="/column/plan-day" target="_blank" rel="noopener noreferrer" className={`${item} border-t`} style={{ borderColor: "var(--border)" }} onClick={() => setOpen(false)}>
            毎朝自動で組ませるには ↗
            <span className={sub} style={{ color: "var(--muted)" }}>Claude のスケジュール済みタスクの設定方法</span>
          </a>
        </div>
      )}
    </div>
  );
}
