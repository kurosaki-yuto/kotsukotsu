"use client";

// Auth-gated, fully dynamic page; skip static prerender (uses useSearchParams).
export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listGoals, listToday, listMessages, sendMessage, getOrgSettings, getMyProfile } from "../lib/addness";
import Linkified from "../components/Linkified";
import type { Goal, ChatMessage } from "../lib/db";
import { supabase } from "../lib/db";

type TodayRow = {
  id: string;
  project_id: string;
  text: string;
  project_name: string | null;
};

type Tab = "today" | "goals";

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatInner />
    </Suspense>
  );
}

function ChatInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [orgName, setOrgName] = useState("ワークスペース");
  const [myName, setMyName] = useState("あなた");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [today, setToday] = useState<TodayRow[]>([]);
  const [tab, setTab] = useState<Tab>("today");
  const [query, setQuery] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(params.get("goal"));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- load lists + org on mount ----
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const org = await getOrgSettings();
        if (alive) setOrgName(org.name || "ワークスペース");
      } catch {
        /* keep fallback */
      }
      try {
        const g = await listGoals();
        if (alive) setGoals(g);
      } catch {
        if (alive) setGoals([]);
      }
      try {
        const t = await listToday();
        if (alive) setToday(t as TodayRow[]);
      } catch {
        if (alive) setToday([]);
      }
      try {
        const p = await getMyProfile();
        if (alive) setMyName(p.name || "あなた");
      } catch {
        /* keep fallback */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ---- load messages on select ----
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const m = await listMessages(selectedId);
        if (alive) setMessages(m);
      } catch {
        if (alive) setMessages([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedId]);

  // ---- realtime: live-append new messages for the open thread ----
  useEffect(() => {
    if (!selectedId) return;
    const ch = supabase()
      .channel(`chat-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `goal_id=eq.${selectedId}` },
        (payload: { new: ChatMessage }) => {
          const row = payload.new as ChatMessage;
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
        }
      )
      .subscribe();
    return () => {
      supabase().removeChannel(ch);
    };
  }, [selectedId]);

  // ---- keep scrolled to bottom ----
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, selectedId]);

  const select = (id: string) => {
    setSelectedId(id);
    const next = new URLSearchParams(Array.from(params.entries()));
    next.set("goal", id);
    router.replace(`/chat?${next.toString()}`);
  };

  const goalById = useMemo(() => {
    const map = new Map<string, Goal>();
    goals.forEach((g) => map.set(g.id, g));
    return map;
  }, [goals]);

  const todayById = useMemo(() => {
    const map = new Map<string, TodayRow>();
    today.forEach((t) => map.set(t.project_id, t));
    return map;
  }, [today]);

  const threadTitle = useMemo(() => {
    if (!selectedId) return "";
    const g = goalById.get(selectedId);
    if (g) return g.name;
    const t = todayById.get(selectedId);
    if (t) return t.text;
    return "スレッド";
  }, [selectedId, goalById, todayById]);

  const filteredToday = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return today;
    return today.filter(
      (t) => t.text.toLowerCase().includes(q) || (t.project_name ?? "").toLowerCase().includes(q)
    );
  }, [today, query]);

  const filteredGoals = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return goals;
    return goals.filter((g) => g.name.toLowerCase().includes(q));
  }, [goals, query]);

  const send = async () => {
    const body = draft.trim();
    if (!body || !selectedId || sending) return;
    setSending(true);
    setDraft("");
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      goal_id: selectedId,
      scope: "goal",
      role: "user",
      author: myName,
      author_email: null,
      body,
      created_at: new Date().toISOString(),
      edited_at: null,
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      await sendMessage(selectedId, body, "user");
      const fresh = await listMessages(selectedId);
      setMessages(fresh);
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(body);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-1 min-h-0 h-screen" style={{ background: "var(--background)" }}>
      {/* ---------- LEFT: thread list ---------- */}
      <aside
        className="w-[300px] flex-shrink-0 flex flex-col min-h-0 border-r"
        style={{ background: "var(--background)", borderColor: "var(--border)" }}
      >
        <div className="px-4 pt-4 pb-3 flex items-center gap-2">
          <span aria-hidden className="text-[var(--muted)] text-base leading-none">
            &#127970;
          </span>
          <h2 className="font-bold text-[15px] truncate cjk">{orgName}</h2>
        </div>

        <div className="px-4 pb-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="チャットを検索"
            className="w-full rounded-[10px] px-3 py-2 text-[13px] outline-none border"
            style={{ background: "var(--hover)", borderColor: "var(--border)", color: "var(--foreground)" }}
          />
        </div>

        <div className="px-4 pb-3 flex gap-2">
          <button className={`chip ${tab === "today" ? "active" : ""}`} onClick={() => setTab("today")}>
            今日のToDo
          </button>
          <button className={`chip ${tab === "goals" ? "active" : ""}`} onClick={() => setTab("goals")}>
            ゴール
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
          {tab === "today" ? (
            filteredToday.length === 0 ? (
              <p className="px-3 py-4 text-[13px] text-[var(--muted)]">今日のToDoがありません</p>
            ) : (
              filteredToday.map((t) => {
                const active = t.project_id === selectedId;
                return (
                  <button
                    key={t.id}
                    onClick={() => select(t.project_id)}
                    className="block w-full text-left px-3 py-2.5 rounded-[10px] mb-0.5"
                    style={{ background: active ? "var(--selected)" : "transparent" }}
                    onMouseEnter={(e) => {
                      if (!active) (e.currentTarget as HTMLButtonElement).style.background = "var(--hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    }}
                  >
                    {t.project_name && (
                      <span className="block text-[11px] text-[var(--muted-soft)] truncate cjk">
                        {t.project_name}
                      </span>
                    )}
                    <span className="block text-[14px] text-[var(--foreground)] truncate cjk">{t.text}</span>
                  </button>
                );
              })
            )
          ) : filteredGoals.length === 0 ? (
            <p className="px-3 py-4 text-[13px] text-[var(--muted)]">ゴールがありません</p>
          ) : (
            filteredGoals.map((g) => {
              const active = g.id === selectedId;
              return (
                <button
                  key={g.id}
                  onClick={() => select(g.id)}
                  className="flex items-center gap-2 w-full text-left px-3 py-2.5 rounded-[10px] mb-0.5"
                  style={{ background: active ? "var(--selected)" : "transparent" }}
                  onMouseEnter={(e) => {
                    if (!active) (e.currentTarget as HTMLButtonElement).style.background = "var(--hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  }}
                >
                  <span aria-hidden className="text-base leading-none flex-shrink-0">
                    {g.emoji ?? "\u{1F3AF}"}
                  </span>
                  <span className="text-[14px] text-[var(--foreground)] truncate cjk">{g.name}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ---------- RIGHT: thread ---------- */}
      <section className="flex-1 flex flex-col min-h-0">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-[var(--muted)] text-[14px] px-8 text-center">
            ゴールを選択するとスレッドが表示されます
          </div>
        ) : (
          <>
            <header
              className="px-6 py-4 border-b flex items-center"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            >
              <h1 className="font-bold text-[15px] truncate cjk">{threadTitle}</h1>
            </header>

            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
              {messages.length === 0 ? (
                <p className="text-center text-[13px] text-[var(--muted)] py-8">まだメッセージがありません</p>
              ) : (
                <div className="flex flex-col gap-3 max-w-[720px] mx-auto">
                  {messages.map((m) => {
                    if (m.role === "system") {
                      return (
                        <div key={m.id} className="text-center text-[12px] text-[var(--muted)] py-1 cjk">
                          <Linkified text={m.body} />
                        </div>
                      );
                    }
                    if (m.role !== "user") {
                      // incoming message from another member
                      return (
                        <div key={m.id} className="flex items-start gap-2.5 max-w-[80%]">
                          <span
                            aria-hidden
                            className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold mt-0.5"
                            style={{ background: "#e3f3e4", color: "#3f8a47" }}
                          >
                            {((m.author ?? "?").trim()[0] ?? "?").toUpperCase()}
                          </span>
                          <div>
                            <div
                              className="rounded-[14px] px-3.5 py-2 text-[14px] leading-relaxed cjk"
                              style={{ background: "var(--hover)", color: "var(--foreground)" }}
                            >
                              <Linkified text={m.body} />
                            </div>
                            <div className="text-[11px] text-[var(--muted)] mt-1 ml-1">
                              {m.author ?? "メンバー"} ・ {timeLabel(m.created_at)}
                            </div>
                          </div>
                        </div>
                      );
                    }
                    // user
                    return (
                      <div key={m.id} className="flex flex-col items-end self-end max-w-[80%]">
                        <div
                          className="rounded-[14px] px-3.5 py-2 text-[14px] leading-relaxed text-white cjk"
                          style={{ background: "var(--accent)" }}
                        >
                          <Linkified text={m.body} linkColor="#ffffff" />
                        </div>
                        <div className="text-[11px] text-[var(--muted)] mt-1 mr-1">
                          {m.author ?? "あなた"} ・ {timeLabel(m.created_at)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* composer */}
            <div
              className="px-6 py-4 border-t"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            >
              <div className="flex items-end gap-2 max-w-[720px] mx-auto">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="メッセージを入力"
                  className="flex-1 rounded-[12px] px-4 py-2.5 text-[14px] outline-none border"
                  style={{ background: "var(--background)", borderColor: "var(--border-strong)", color: "var(--foreground)" }}
                />
                <button
                  onClick={() => void send()}
                  disabled={!draft.trim() || sending}
                  aria-label="送信"
                  className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white transition disabled:opacity-40"
                  style={{ background: "var(--accent)" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
