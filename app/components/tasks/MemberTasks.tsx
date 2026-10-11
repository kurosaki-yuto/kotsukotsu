"use client";

// メンバー (管理者以外) 向けの「自分のタスク」一覧。ツリーも新規作成も無い。app/page.tsx から切り出し。
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getMyTasks, toggleItemDone, setItemStarted, prefetchGoalBundle, type MyTask } from "../../lib/addness";
import { useAutoRefresh } from "../../lib/useAutoRefresh";
import { InProgressBadge, StartButton, TaskCheck } from "../InProgress";

// ---------- member personal worklist (no tree, no create) ----------
export type TaskGroup = { goalId: string | null; name: string; emoji: string | null; tasks: MyTask[] };

export function groupByParent(tasks: MyTask[]): TaskGroup[] {
  const groups: TaskGroup[] = [];
  const byKey = new Map<string, TaskGroup>();
  for (const t of tasks) {
    const key = t.parent_goal_id ?? "__none__";
    let g = byKey.get(key);
    if (!g) {
      g = {
        goalId: t.parent_goal_id,
        name: t.parent_name || "その他",
        emoji: t.parent_emoji,
        tasks: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.tasks.push(t);
  }
  return groups;
}

export function MemberTasks({ router }: { router: ReturnType<typeof useRouter> }) {
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [doneOpen, setDoneOpen] = useState<Record<string, boolean>>({});
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const mine = await getMyTasks().catch(() => [] as MyTask[]);
        if (!alive) return;
        setTasks(mine);
      } catch {
        /* tolerate */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useAutoRefresh(() => { getMyTasks().then(setTasks).catch(() => {}); });

  const groups = useMemo(() => groupByParent(tasks), [tasks]);

  const toggle = async (id: string, done: boolean) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status: done ? "done" : "active" } : t)));
    try {
      await toggleItemDone(id, done);
    } catch {
      /* optimistic; tolerate */
    }
  };

  const start = async (id: string, started: boolean) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, started_at: started ? new Date().toISOString() : null, started_via: started ? "app" : null } : t)));
    try {
      await setItemStarted(id, started);
      setTasks(await getMyTasks());
    } catch {
      /* optimistic; tolerate */
    }
  };

  if (loading) {
    return <div className="py-8 text-[14px] text-[var(--muted)]">読み込み中…</div>;
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-3 py-20">
        <span className="w-12 h-12 rounded-2xl border-2 border-dashed flex items-center justify-center" style={{ borderColor: "var(--border-strong)", color: "var(--muted-soft)" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
        </span>
        <p className="text-[15px] font-semibold text-[var(--foreground)] cjk">まだタスクがありません</p>
        <p className="text-[13px] text-[var(--muted-soft)] cjk">管理者からタスクをもらってください。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => {
        const key = g.goalId ?? "__none__";
        const activeTasks = g.tasks.filter((t) => t.status !== "done");
        const doneTasks = g.tasks.filter((t) => t.status === "done");
        const open = doneOpen[key] ?? false;
        const gopen = groupOpen[key] ?? false;
        return (
          <div key={key}>
            <button
              type="button"
              onClick={() => setGroupOpen((m) => ({ ...m, [key]: !gopen }))}
              className="flex items-center gap-1.5 mb-2 w-full text-left text-[13px] font-semibold text-[var(--muted)] cjk min-w-0 hover:text-[var(--foreground)] transition-colors"
              aria-expanded={gopen}
            >
              <svg viewBox="0 0 16 16" className="w-3 h-3 flex-none transition-transform" style={{ transform: gopen ? "rotate(90deg)" : "none" }} fill="currentColor"><path d="M6 3l5 5-5 5V3z" /></svg>
              {g.emoji && <span className="flex-none">{g.emoji}</span>}
              <span className="break-words min-w-0">{g.name}</span>
              <span className="flex-none font-normal text-[var(--muted-soft)]">{activeTasks.length}</span>
            </button>
            {gopen && activeTasks.length > 0 && (
              <ul className="card divide-y divide-[var(--border)]">
                {activeTasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--hover)] group" onMouseEnter={() => prefetchGoalBundle(t.id)}>
                    {/* done checkbox */}
                    <TaskCheck t={t} onToggle={(d) => toggle(t.id, d)} onStop={() => start(t.id, false)} parent={(t.open_children ?? 0) > 0} />
                    {/* name → open */}
                    <button
                      onClick={() => router.push(`/goals/${t.id}`)}
                      className="flex-1 min-w-0 text-left text-[14.5px] break-words cjk hover:underline text-[var(--foreground)]"
                    >
                      {t.emoji && <span className="mr-1.5">{t.emoji}</span>}
                      {t.name || "（無題）"}
                    </button>
                    <InProgressBadge t={t} wrapClass="hidden sm:inline-flex" parent={(t.open_children ?? 0) > 0} />
                    <StartButton t={t} parent={(t.open_children ?? 0) > 0} onToggle={(on) => start(t.id, on)} wrapClass="hidden lg:inline-flex lg:opacity-0 lg:group-hover:opacity-100" />
                  </li>
                ))}
              </ul>
            )}

            {/* 完了 (done) — collapsible, collapsed by default */}
            {gopen && doneTasks.length > 0 && (
              <div className={activeTasks.length > 0 ? "mt-2" : ""}>
                <button
                  type="button"
                  onClick={() => setDoneOpen((m) => ({ ...m, [key]: !open }))}
                  className="flex items-center gap-1.5 w-full text-left text-[12.5px] font-semibold text-[var(--muted)] hover:text-[var(--foreground)] transition-colors py-1.5 cjk"
                  aria-expanded={open}
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="w-3 h-3 flex-shrink-0 transition-transform"
                    style={{ transform: open ? "rotate(90deg)" : "none" }}
                    fill="currentColor"
                  >
                    <path d="M6 3l5 5-5 5V3z" />
                  </svg>
                  完了 ({doneTasks.length})
                </button>

                {open && (
                  <ul className="card divide-y divide-[var(--border)] mt-1">
                    {doneTasks.map((t) => (
                      <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--hover)] group" onMouseEnter={() => prefetchGoalBundle(t.id)}>
                        {/* filled checkbox → restore to active */}
                        <button
                          onClick={() => toggle(t.id, false)}
                          className="w-5 h-5 shrink-0 rounded-full border flex items-center justify-center transition-colors"
                          style={{ background: "var(--accent)", borderColor: "var(--accent)" }}
                          aria-label="未完了に戻す"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                        </button>
                        {/* name → open */}
                        <button
                          onClick={() => router.push(`/goals/${t.id}`)}
                          className="flex-1 min-w-0 text-left text-[14.5px] break-words cjk hover:underline line-through text-[var(--muted-soft)]"
                        >
                          {t.emoji && <span className="mr-1.5">{t.emoji}</span>}
                          {t.name || "（無題）"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
