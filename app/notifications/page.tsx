"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { listNotifications, markRead, markAllRead, markNotificationsSeen } from "../lib/addness";
import { enablePush, isStandalone, pushSupported } from "../lib/push-client";
import type { AppNotification } from "../lib/db";
import { supabase } from "../lib/db";

type Tab = "未読" | "すべて";

const KIND_DOT: Record<string, string> = {
  info: "#909398",
  mention: "#1d3b9e",
  goal: "#1d3b9e",
  streak: "#f59e0b",
  addy: "#6d5ae6",
};

function dotColor(kind: string): string {
  return KIND_DOT[kind] ?? "#909398";
}

const KIND_LABEL: Record<string, string> = {
  info: "コメント",
  mention: "アサイン",
  goal: "完了",
  streak: "達成",
  addy: "AI",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "たった今";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  return `${day}日前`;
}

export default function NotificationsPage() {
  const router = useRouter();

  // default to the full record so reading a notification never makes it vanish
  // from the list (the 未読 tab still exists for filtering).
  const [tab, setTab] = useState<Tab>("すべて");
  const [items, setItems] = useState<AppNotification[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  // empty = show every kind (unfiltered)
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());
  const toggleKind = useCallback((k: string) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);
  const [newestFirst, setNewestFirst] = useState(true);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const onEnablePush = useCallback(async () => {
    if (!pushSupported()) { setPushMsg("この端末/ブラウザは通知非対応です"); return; }
    // iOS only allows Web Push from an installed PWA (Add to Home Screen).
    const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (iOS && !isStandalone()) { setPushMsg("iPhoneは「ホーム画面に追加」してから開いて、もう一度オンにしてください"); return; }
    setPushMsg("設定中…");
    const r = await enablePush();
    setPushMsg(r.ok ? "通知オン。完了したら端末に届きます" : r.reason === "denied" ? "通知が許可されませんでした(端末設定で許可して再試行)" : "通知の設定に失敗しました");
  }, []);

  // Refresh keeps whatever the viewer has already paged in, so a background
  // poll never shrinks the list back to the first page.
  const loadedRef = useRef(0);
  const reload = useCallback(async () => {
    try {
      const want = Math.max(loadedRef.current, 1);
      const pages: AppNotification[] = [];
      let more = false;
      let offset = 0;
      do {
        const page = await listNotifications(tab === "未読" ? "unread" : "all", offset);
        pages.push(...page.items);
        more = page.hasMore;
        offset = pages.length;
      } while (more && pages.length < want);
      loadedRef.current = pages.length;
      setItems(pages);
      setHasMore(more);
    } catch {
      setItems([]);
      setHasMore(false);
    }
  }, [tab]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await listNotifications(tab === "未読" ? "unread" : "all", items.length);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        const next = [...prev, ...page.items.filter((x) => !seen.has(x.id))];
        loadedRef.current = next.length;
        return next;
      });
      setHasMore(page.hasMore);
    } catch {
      /* leave the list as-is */
    } finally {
      setLoadingMore(false);
    }
  }, [tab, items.length]);

  // reset paging when the tab changes, then load
  useEffect(() => {
    loadedRef.current = 0;
    void reload();
  }, [reload]);

  // Opening this page drops the bell badge — but does NOT mark anything read,
  // so the list still shows which ones you haven't opened yet. 全部消したい
  // ときは「すべて既読」。
  const seenRef = useRef(false);
  useEffect(() => {
    if (seenRef.current) return;
    seenRef.current = true;
    void markNotificationsSeen().catch(() => { /* badge stays; not worth failing over */ });
  }, []);

  // realtime: any change to notifications reloads the list
  useEffect(() => {
    try {
      const channel = supabase()
        .channel("notif")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notifications" },
          () => {
            void reload();
          }
        )
        .subscribe();
      return () => {
        try {
          supabase().removeChannel(channel);
        } catch {
          /* env may be missing */
        }
      };
    } catch {
      // env may be missing — skip realtime, page still renders
      return undefined;
    }
  }, [reload]);

  // live refresh without supabase: poll every 15s + refetch on window focus
  useEffect(() => {
    const id = setInterval(() => {
      void reload();
    }, 15000);
    const onFocus = () => {
      void reload();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);

  const sorted = useMemo(() => {
    const base = activeKinds.size ? items.filter((n) => activeKinds.has(n.kind)) : items;
    const copy = [...base];
    copy.sort((a, b) => {
      const av = new Date(a.created_at).getTime();
      const bv = new Date(b.created_at).getTime();
      return newestFirst ? bv - av : av - bv;
    });
    return copy;
  }, [items, newestFirst, activeKinds]);

  const selected = useMemo(
    () => sorted.find((n) => n.id === selectedId) ?? null,
    [sorted, selectedId]
  );

  const onSelect = useCallback(
    async (n: AppNotification) => {
      setSelectedId(n.id);
      if (!n.read_at) {
        // optimistic: reflect read state locally without dropping it from the list
        setItems((prev) =>
          prev.map((x) =>
            x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x
          )
        );
        try {
          await markRead(n.id);
        } catch {
          /* env may be missing */
        }
      }
    },
    []
  );

  const onMarkAll = useCallback(async () => {
    setItems((prev) =>
      prev.map((x) => (x.read_at ? x : { ...x, read_at: new Date().toISOString() }))
    );
    try {
      await markAllRead();
    } catch {
      /* env may be missing */
    }
    void reload();
  }, [reload]);

  const empty = sorted.length === 0;

  return (
    <div
      className="flex-1 min-h-0 h-screen p-0 md:p-4"
      style={{ background: "var(--app-bg)" }}
    >
      <div className="card flex flex-col h-full overflow-hidden rounded-none md:rounded-[var(--radius)]">
        {/* header bar */}
        <div
          className="flex flex-wrap items-center gap-2 md:gap-3 px-3 md:px-5 py-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="tab-seg">
            <button
              className={tab === "未読" ? "active" : ""}
              onClick={() => setTab("未読")}
            >
              未読
            </button>
            <button
              className={tab === "すべて" ? "active" : ""}
              onClick={() => setTab("すべて")}
            >
              すべて
            </button>
          </div>

          <div className="relative">
            <button
              className={`chip${activeKinds.size ? " active" : ""}`}
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
            >
              フィルター{activeKinds.size > 0 && ` (${activeKinds.size})`} <span style={{ color: "var(--muted-soft)" }}>▾</span>
            </button>
            {filterOpen && (
              <div
                className="absolute left-0 top-full mt-1 z-10 rounded-lg border py-1 min-w-[170px]"
                style={{
                  background: "var(--surface)",
                  borderColor: "var(--border-strong)",
                  boxShadow: "var(--shadow-pop)",
                }}
              >
                {(["info", "mention", "goal", "streak", "addy"] as const).map(
                  (k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleKind(k)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-[var(--hover)]"
                      style={{ color: "var(--foreground-soft)" }}
                    >
                      <span
                        className="inline-block rounded-full shrink-0"
                        style={{
                          width: 8,
                          height: 8,
                          background: dotColor(k),
                        }}
                      />
                      <span className="flex-1">{KIND_LABEL[k]}</span>
                      {activeKinds.has(k) && (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l4 4 10-11" /></svg>
                      )}
                    </button>
                  )
                )}
                {activeKinds.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveKinds(new Set())}
                    className="flex w-full items-center px-3 py-1.5 text-xs text-left hover:bg-[var(--hover)] border-t"
                    style={{ color: "var(--muted)", borderColor: "var(--border)" }}
                  >
                    フィルターを解除
                  </button>
                )}
              </div>
            )}
          </div>

          <button
            className="chip"
            onClick={() => setNewestFirst((v) => !v)}
            title="並び順を切り替え"
          >
            <span style={{ color: "var(--muted-soft)" }}>↓</span>{" "}
            {newestFirst ? "新しい順" : "古い順"}
          </button>

          <button className="chip flex items-center gap-1" onClick={onEnablePush} title="この端末に完了通知を届ける">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
            端末に通知
          </button>
          {pushMsg && <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>{pushMsg}</span>}

          <div className="ml-auto">
            <button
              className="text-sm"
              style={{ color: "var(--muted)" }}
              onClick={onMarkAll}
            >
              すべて既読
            </button>
          </div>
        </div>

        {/* body: list + detail */}
        <div className="flex flex-1 min-h-0">
          {/* list pane */}
          <div
            className={`${
              selected ? "hidden md:block" : "block"
            } w-full md:w-[340px] md:flex-[0_0_340px] border-r overflow-y-auto pb-24 md:pb-0`}
            style={{ borderColor: "var(--border)" }}
          >
            {empty ? (
              <div
                className="h-full flex items-center justify-center text-sm"
                style={{ color: "var(--muted-soft)" }}
              >
                通知はありません
              </div>
            ) : (
              <ul>
                {sorted.map((n) => {
                  const unread = !n.read_at;
                  const active = n.id === selectedId;
                  return (
                    <li key={n.id}>
                      <button
                        onClick={() => void onSelect(n)}
                        className="w-full text-left flex gap-3 px-4 py-3 border-b"
                        style={{
                          borderColor: "var(--border)",
                          borderLeft: unread
                            ? "3px solid var(--accent)"
                            : "3px solid transparent",
                          background: active ? "var(--selected)" : "transparent",
                        }}
                      >
                        <span
                          className="inline-block rounded-full shrink-0"
                          style={{
                            width: 9,
                            height: 9,
                            marginTop: 6,
                            background: dotColor(n.kind),
                          }}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-baseline gap-2">
                            <span
                              className="truncate flex-1 min-w-0 cjk"
                              style={{
                                fontWeight: unread ? 600 : 500,
                                color: "var(--foreground)",
                              }}
                            >
                              {n.title}
                            </span>
                            <span
                              className="text-xs shrink-0"
                              style={{ color: "var(--muted-soft)" }}
                            >
                              {relativeTime(n.created_at)}
                            </span>
                          </span>
                          {n.body && (
                            <span
                              className="block truncate text-sm mt-0.5 cjk"
                              style={{ color: "var(--muted)" }}
                            >
                              {n.body}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="w-full py-3 text-sm"
                style={{ color: "var(--muted)" }}
              >
                {loadingMore ? "読み込み中…" : "もっと見る"}
              </button>
            )}
          </div>

          {/* detail pane */}
          <div
            className={`${
              selected ? "block" : "hidden md:block"
            } flex-1 min-w-0 overflow-y-auto pb-24 md:pb-0`}
          >
            {empty || !selected ? (
              <div
                className="h-full flex items-center justify-center text-sm"
                style={{ color: "var(--muted-soft)" }}
              >
                通知はありません
              </div>
            ) : (
              <div className="px-4 md:px-8 py-5 md:py-7 max-w-2xl">
                {/* mobile-only back button to return to the list */}
                <button
                  type="button"
                  className="md:hidden chip mb-3"
                  onClick={() => setSelectedId(null)}
                >
                  ← 戻る
                </button>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="inline-block rounded-full"
                    style={{
                      width: 9,
                      height: 9,
                      background: dotColor(selected.kind),
                    }}
                  />
                  <span className="text-xs" style={{ color: "var(--muted-soft)" }}>
                    {relativeTime(selected.created_at)}
                  </span>
                </div>
                <h1
                  className="text-lg font-semibold cjk"
                  style={{ color: "var(--foreground)" }}
                >
                  {selected.title}
                </h1>
                {selected.body && (
                  <p
                    className="mt-4 whitespace-pre-wrap cjk"
                    style={{ color: "var(--foreground-soft)", lineHeight: 1.8 }}
                  >
                    {selected.body}
                  </p>
                )}
                {selected.goal_id && (
                  <button
                    type="button"
                    className="btn-dark mt-5"
                    onClick={() => router.push(`/goals/${selected.goal_id}`)}
                  >
                    該当ページに飛ぶ
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
