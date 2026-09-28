"use client";

import { useEffect, useRef, useState } from "react";
import { listMessages, sendMessage } from "../lib/addness";
import { supabase, type ChatMessage } from "../lib/db";

export default function ChatDock({ goalId }: { goalId: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => { try { const m = await listMessages(goalId); if (alive) setMsgs(m); } catch {} })();
    let ch: ReturnType<ReturnType<typeof supabase>["channel"]> | null = null;
    try {
      ch = supabase().channel(`chat-${goalId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: `goal_id=eq.${goalId}` },
          (p: { new: ChatMessage }) => setMsgs((prev) => (prev.some((x) => x.id === (p.new as ChatMessage).id) ? prev : [...prev, p.new as ChatMessage])))
        .subscribe();
    } catch {}
    return () => { alive = false; if (ch) try { supabase().removeChannel(ch); } catch {} };
  }, [goalId]);

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, open]);

  const send = async () => {
    const body = input.trim();
    if (!body) return;
    setInput("");
    try { await sendMessage(goalId, body, "user"); } catch (e) { console.error(e); }
  };

  return (
    <>
      <button onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 px-4 h-11 rounded-full text-white text-sm font-semibold shadow-lg"
        style={{ background: "#2b2d31" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z" /></svg>
        {msgs.length}件
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-30 w-[380px] max-w-[92vw] h-[520px] card flex flex-col overflow-hidden" style={{ boxShadow: "var(--shadow-pop)" }}>
          <div className="flex items-center justify-between px-4 h-12 border-b" style={{ borderColor: "var(--border)" }}>
            <div className="font-semibold text-sm">スレッド</div>
            <button onClick={() => setOpen(false)} className="text-[var(--muted)] hover:text-[var(--foreground)]" aria-label="閉じる">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {msgs.length === 0 && <div className="text-center text-sm text-[var(--muted-soft)] pt-10">まだメッセージがありません</div>}
            {msgs.map((m) => {
              if (m.role === "system") return <div key={m.id} className="text-center text-xs text-[var(--muted-soft)]">{m.body}</div>;
              const mine = m.role === "user";
              return (
                <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"} gap-2`}>
                  {!mine && (
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                      style={{ background: "#e3f3e4", color: "#3f8a47" }}
                    >
                      {((m.author ?? "?").trim()[0] ?? "?").toUpperCase()}
                    </div>
                  )}
                  <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-[14px] ${mine ? "text-white rounded-br-sm" : "rounded-bl-sm"}`}
                    style={{ background: mine ? "var(--accent)" : "var(--hover)", color: mine ? "#fff" : "var(--foreground)" }}>
                    {m.body}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          <div className="border-t p-2 flex items-center gap-2" style={{ borderColor: "var(--border)" }}>
            <input value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
              placeholder="メッセージを入力…" className="flex-1 bg-transparent px-2 py-2 text-sm focus:outline-none" />
            <button onClick={send} className="w-9 h-9 rounded-full flex items-center justify-center text-white" style={{ background: "var(--accent)" }} aria-label="送信">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l18-8-8 18-2-7-8-3z" /></svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
