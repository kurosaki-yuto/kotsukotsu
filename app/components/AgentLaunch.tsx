"use client";

import { useEffect, useRef, useState } from "react";
import { mcpConnectHint } from "../lib/hosts";

// ゴール詳細の「完了にする」の横に置く「AIで進める」プルダウン。
// Claude / Codex のデスクトップアプリを、このゴールの指示文入りで開く (送信は本人がアプリ側で Enter)。
// サービスページの「アプリで開く」と同じ URL を使う。
//   Claude: claude://code/new?q=...          (Claude Desktop の Code 画面)
//   Codex:  codex://threads/new?prompt=...   (Codex アプリ)
// claude.ai/code・chatgpt.com/codex は X-Frame-Options: SAMEORIGIN で埋め込めないため、別アプリで開く形にしている。

// 細かい書き方 (完了の基準・現状の形式など) はこつこつ MCP の instructions に任せ、ここは着手の順番と止まる場所だけ書く。
// claude-cli の q は 5000 字まで。長くしすぎない。
function promptFor(id: string, name: string): string {
  return [
    `こつこつのタスク「${name}」を進めてください。`,
    `id: ${id}`,
    "",
    `1. こつこつのツールが読み (get_goal) と書き (add_subtask・update_goal・send_chat) の両方使えるか確かめる。どちらかが無ければ何もせず「こつこつが未接続です。${mcpConnectHint()}」とだけ返す`,
    "2. get_goal・list_subtasks・list_comments で、このタスクの完了の基準・現状・未完了の作業・最新のコメントを読む。親を最上位まで辿り、上位の完了の基準に寄与しないならそこで止めて理由を伝える",
    "3. 完了の基準が空か曖昧なら、分かる事実で書き直す。分からない点は質問して止まる",
    "4. 作業に要るファイルやコードの場所は、今いるフォルダと、タスクの現状・リソース・コメントに書かれたパスだけを見る。ホームフォルダ全体を探し回らず、書かれていなければ聞く",
    "5. 作業ステップを2〜5個 add_subtask で登録してから着手し、1つ終わるごとに complete_subtask する",
    "6. 結果はこのタスク自身に書く。update_goal で現状 (日付 / 済んだこと / ボール / 残り・詰まり) を書き直し、報告はこのタスクに send_chat する",
    "7. 外への送信・公開・金銭・契約・本番データの削除は、実行する前に必ず私の承認を取る",
    "8. 最後に、完了の基準の各項目を満たしたかどうかを1行ずつ報告して止まる",
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
