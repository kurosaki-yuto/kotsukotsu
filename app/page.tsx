"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  listGoals,
  createGoal,
  createChild,
  archiveGoal,
  moveGoal,
  listGoalMembersBatch,
  listGoalMembersAll,
  getMe,
  getMyTasks,
  toggleItemDone,
  setItemStarted,
  prefetchGoalBundle,
  type GoalMember,
  type MyTask,
} from "./lib/addness";
import type { Goal } from "./lib/db";
import { useAutoRefresh } from "./lib/useAutoRefresh";
import MyTurn from "./components/MyTurn";
import { ItemRow } from "./components/tasks/ItemRow";
import { daysUntil, useIndent, countChildren, buildItemTree, pruneToAssigned, type DropPos, type DropHint } from "./components/tasks/tree";
import DoneCounts from "./components/DoneCounts";
import { Chevron, useCollapsed } from "./lib/useCollapsed";

let loadBusy = false;
let loadAt = 0;

export default function TasksPage() {
  const router = useRouter();
  const indent = useIndent();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [myEmail, setMyEmail] = useState<string | null>(null);
  // 「期限が近い」の開け閉め (スマホの上の段と PC の右の段で同じ状態を使う。端末に覚える)
  const [deadlinesClosed, toggleDeadlines] = useCollapsed("deadlines");
  const [scoped, setScoped] = useState(false); // task-scoped member: sees their subtree
  const [items, setItems] = useState<Goal[]>([]);
  const [members, setMembers] = useState<Record<string, GoalMember[]>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [operableIds, setOperableIds] = useState<Set<string> | null>(null); // null = full editor view
  const [dragId, setDragId] = useState<string | null>(null); // row being dragged
  const [dropHint, setDropHint] = useState<DropHint>(null); // active drop indicator
  const seededCollapse = useRef<"none" | "active" | "full">("none");
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Apply a computed view (full tree or pruned member view). On the first load,
  // seed the collapsed set so the tree opens closed — but keep the ancestor
  // context chain expanded (only collapse operable parents) so an assigned
  // member can immediately see their item and what it connects to.
  // `activeOnly` = the first, done-less list. When the full list lands after it,
  // only the done parents are added to the collapsed set, so rows the viewer
  // already opened in the meantime stay open.
  const applyView = (visible: Goal[], operable: Set<string> | null, activeOnly = false) => {
    setItems(visible);
    setOperableIds(operable);
    if (seededCollapse.current === "full" || visible.length === 0) return;
    if (activeOnly && seededCollapse.current === "active") return;
    const parents = new Set<string>();
    for (const it of visible) {
      const p = it.parent_goal_id;
      if (p && (operable == null || operable.has(p))) parents.add(p);
    }
    if (seededCollapse.current === "none") {
      setCollapsed(parents);
    } else {
      const done = new Set(visible.filter((it) => it.status === "done").map((it) => it.id));
      setCollapsed((prev) => {
        const n = new Set(prev);
        for (const p of parents) if (done.has(p)) n.add(p);
        return n;
      });
    }
    seededCollapse.current = activeOnly ? "active" : "full";
  };

  const load = async () => {
    // focus + visibilitychange + realtime ping can all fire within the same second
    // (each was a full /api/goals + assignee batch). Coalesce: skip while one is
    // in flight and enforce a short minimum gap.
    if (loadBusy || Date.now() - loadAt < 3000) return;
    loadBusy = true;
    try { await loadOnce(); } finally { loadBusy = false; loadAt = Date.now(); }
  };
  const loadOnce = async () => {
    const membersP = (admin || scoped) ? listGoalMembersAll().catch(() => ({}) as Record<string, GoalMember[]>) : null;
    const all = await listGoals().catch(() => [] as Goal[]);
    // admins / scoped editors see the full tree; plain members see only their
    // assigned items + the chain showing what those connect to.
    let visible = all;
    let operable: Set<string> | null = null;
    if (admin === false && !scoped) {
      const mine = await getMyTasks().catch(() => [] as MyTask[]);
      const pruned = pruneToAssigned(all, new Set(mine.map((t) => t.id)));
      visible = pruned.visible;
      operable = pruned.operable;
    }
    applyView(visible, operable);
    // fetch assignees for every visible item in one batched request
    const byGoal = await (membersP ?? listGoalMembersBatch(visible.map((it) => it.id))).catch(() => ({}) as Record<string, GoalMember[]>);
    setMembers(byGoal);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        // the tree and its assignees don't depend on who we are — start them now
        // and let /api/auth/me resolve in parallel (it used to gate everything)
        // 完了は全体の9割 (2026-10 時点で2,600件超・一覧の大半のバイト数)。未完了だけを
        // 先に取って描き、完了込みの全体は裏で追いかけて差し替える。
        const activeP = listGoals({ activeOnly: true }).catch(() => null);
        const goalsP = listGoals().catch(() => null);
        const membersP = listGoalMembersAll().catch(() => ({}) as Record<string, GoalMember[]>);
        const me = await getMe().catch(() => ({ user: null, needsBootstrap: false, scopeGoalId: null }));
        const isAdmin = me?.user?.role === "admin";
        const isScoped = !!me?.scopeGoalId;
        if (!alive) return;
        setAdmin(isAdmin); setScoped(isScoped); setMyEmail(me?.user?.email ?? null);
        // admins / scoped editors see the full tree (and can mutate it). Plain
        // members see only their assigned items + the ancestor chain showing what
        // those connect to (read-only context); unrelated branches are dropped.
        // admins / scoped: assignees don't depend on the id list, so fetch them in
        // parallel with the tree instead of after it
        const mineP = !isAdmin && !isScoped ? getMyTasks().catch(() => [] as MyTask[]) : null;
        const view = async (all: Goal[]) => {
          if (!mineP) return { visible: all, operable: null };
          const mine = await mineP;
          return pruneToAssigned(all, new Set(mine.map((t) => t.id)));
        };
        let fullApplied = false;
        void activeP.then(async (active) => {
          if (!active) return;
          const v = await view(active);
          if (!alive || fullApplied) return;
          applyView(v.visible, v.operable, true);
          setLoading(false);
        });
        // 全体の取得に失敗したら、先に出した未完了のツリーは消さずに残す (失敗はバナーが出る)
        const all = (await goalsP) ?? (await activeP) ?? [];
        if (!alive) return;
        const { visible, operable } = await view(all);
        if (!alive) return;
        fullApplied = true;
        applyView(visible, operable);
        setLoading(false); // render the tree immediately; holder avatars stream in after
        // holder avatars — one batched request, background, non-blocking
        membersP.then((byGoal) => { if (alive) setMembers(byGoal); }).catch(() => {});
      } catch {
        /* env not set yet / network — stay tolerant */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // keep the tree fresh (other devices / AI via MCP) on focus + interval
  useAutoRefresh(() => { void load(); }, { enabled: admin !== null });

  const stats = useMemo(() => countChildren(items), [items]);

  // 完了を出しているタスクの id。行ごとに持つので、見たいところだけ開ける。
  const [doneShown, setDoneShown] = useState<Set<string>>(new Set());
  // 完了した子を1件以上持つタスク = 「完了を表示」を出せる行
  const doneParents = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, st] of stats) if (st.done > 0) ids.add(id);
    return ids;
  }, [stats]);
  const showDone = doneShown.size > 0; // 上のトグルの見た目 (1件でも出していれば ON)

  const toggleDoneChildren = (id: string) =>
    setDoneShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem("kk:showDone", next.size >= doneParents.size && doneParents.size > 0 ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });

  // 上のトグルは一括切り替え。全部出す / 全部しまう。
  const toggleShowDone = () => {
    setDoneShown((prev) => {
      const next = prev.size > 0 ? new Set<string>() : new Set(doneParents);
      try { localStorage.setItem("kk:showDone", next.size > 0 ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  };
  // 前回「全部表示」で終えていたら、読み込み後にその状態へ戻す
  const restoredDone = useRef(false);
  useEffect(() => {
    if (restoredDone.current || doneParents.size === 0) return;
    restoredDone.current = true;
    try { if (localStorage.getItem("kk:showDone") === "1") setDoneShown(new Set(doneParents)); } catch { /* private mode */ }
  }, [doneParents]);

  // ツリーに出すのは、生きている親にぶら下がっていて、かつその親で「表示」に
  // している完了だけ。親のいない完了 (階層化される前に作られた分が2000件以上ある)
  // を混ぜると最上位が完了で埋まって、今やることが読めなくなる。
  const shownItems = useMemo(() => {
    const alive = items.filter((it) => it.status !== "done");
    if (doneShown.size === 0) return alive;
    const included = new Set(alive.map((it) => it.id));
    const pending = items.filter((it) => it.status === "done" && it.parent_goal_id != null);
    // 親が入っていて、その親が「表示」のときだけ足す。最上位へは浮かない
    for (let pass = 0; pass < 40; pass++) {
      let added = false;
      for (const it of pending) {
        if (included.has(it.id)) continue;
        const p = it.parent_goal_id!;
        if (included.has(p) && doneShown.has(p)) { included.add(it.id); added = true; }
      }
      if (!added) break;
    }
    return items.filter((it) => included.has(it.id));
  }, [items, doneShown]);

  const tree = useMemo(() => buildItemTree(shownItems), [shownItems]);
  // ツリーに出ない完了 (親のいない単発の完了タスク)。常に畳んだまま下に置く
  const doneItems = useMemo(
    () => items.filter((it) => it.status === "done" && !it.parent_goal_id),
    [items]
  );
  // トグルの横に出す件数 = ツリーに出せる完了の数
  const doneCount = useMemo(
    () => items.filter((it) => it.status === "done" && it.parent_goal_id != null).length,
    [items]
  );
  // deadline within a week (or already overdue), soonest first
  // 「期限が近い」に出す範囲。7日にすると同じ期日のゴールが一度に並んで、本当に
  // 今日明日のものが埋もれる。手前の3日だけにして、期限切れは日数に関係なく残す。
  const DEADLINE_SOON_DAYS = 3;
  const upcomingDeadlines = useMemo(
    () =>
      items
        .filter((it) => it.deadline && it.status === "active" && (members[it.id] ?? []).some((m) => m.is_you))
        .map((it) => ({ ...it, daysLeft: daysUntil(it.deadline!) }))
        .filter((it) => it.daysLeft <= DEADLINE_SOON_DAYS)
        .sort((a, b) => a.daysLeft - b.daysLeft),
    [items, members]
  );

  const handleCreate = async () => {
    if (creating) return;
    try {
      setCreating(true);
      const goal = await createGoal("");
      router.push(`/goals/${goal.id}`);
    } catch {
      setCreating(false);
    }
  };

  const handleAddChild = async (parentId: string) => {
    try {
      const child = await createChild(parentId);
      router.push(`/goals/${child.id}`);
    } catch {
      await load().catch(() => {});
    }
  };

  const handleArchive = async (id: string) => {
    if (!window.confirm("このタスクを削除しますか?")) return;
    try {
      await archiveGoal(id);
    } catch {
      /* tolerate */
    }
    await load().catch(() => {});
  };

  const handleToggleDone = async (id: string, done: boolean) => {
    try {
      await toggleItemDone(id, done);
    } catch {
      /* tolerate */
    }
    await load().catch(() => {});
  };

  const handleStart = async (id: string, started: boolean) => {
    try {
      await setItemStarted(id, started);
    } catch {
      /* tolerate */
    }
    // 押した結果はすぐ見せる。load() は3秒以内の読み直しを間引くので、開始→停止と続けて押すと2回目が画面に出ない
    await loadOnce().catch(() => {});
  };

  const handleMove = async (id: string, newParentId: string | null, beforeId: string | null = null) => {
    try {
      await moveGoal(id, newParentId, beforeId);
    } catch {
      /* tolerate */
    }
    await load().catch(() => {});
  };

  // ---- drag & drop reordering / re-parenting ----
  const onDragStartRow = (id: string) => setDragId(id);
  const onDragEndRow = () => { setDragId(null); setDropHint(null); };
  const onDragOverRow = (id: string, pos: DropPos) =>
    setDropHint((h) => (h && h.id === id && h.pos === pos ? h : { id, pos }));
  const onDropRow = () => {
    const dragged = dragId;
    const hint = dropHint;
    setDragId(null);
    setDropHint(null);
    if (!dragged || !hint || dragged === hint.id) return;
    const byId = new Map(items.map((g) => [g.id, g]));
    const target = byId.get(hint.id);
    if (!target) return;
    let newParentId: string | null;
    let beforeId: string | null = null;
    if (hint.pos === "inside") {
      newParentId = target.id; // nest as a child (appended to the end)
    } else {
      newParentId = target.parent_goal_id ?? null;
      const sibs = items
        .filter((g) => (g.parent_goal_id ?? null) === newParentId && g.status !== "archived")
        .sort((a, b) => a.order_idx - b.order_idx);
      const tIdx = sibs.findIndex((s) => s.id === target.id);
      beforeId = hint.pos === "before" ? target.id : sibs[tIdx + 1]?.id ?? null;
    }
    // client-side cycle guard: never drop a node into its own subtree
    let cur: string | null = newParentId;
    while (cur) {
      if (cur === dragged) return;
      cur = byId.get(cur)?.parent_goal_id ?? null;
    }
    void handleMove(dragged, newParentId, beforeId);
  };

  return (
    <div className="min-h-full bg-white">
      <div className="max-w-3xl lg:max-w-[1360px] mx-auto px-4 md:px-10 py-9 pb-24 md:pb-12">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-1">
          <h1 className="text-[22px] font-bold">タスク</h1>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link href="/templates" className="chip" title="型 (入力値 + 資料 + タスクの木) からゴールを作って振る">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /></svg>
              <span className="hidden md:inline">型から作る</span><span className="md:hidden">型</span>
            </Link>
            <button
              type="button"
              onClick={toggleShowDone}
              className={`chip${showDone ? " chip-done-on" : ""}`}
              aria-pressed={showDone}
              title={showDone ? "すべてのタスクの完了を隠す" : "すべてのタスクの完了をその場に表示する"}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              <span className="hidden md:inline">{showDone ? "完了を全部隠す" : "完了を全部表示"}</span><span className="md:hidden">{showDone ? "完了を隠す" : "完了"}</span>
              {doneCount > 0 && <span className="opacity-70">{doneCount}</span>}
            </button>
            {admin && (
              <button onClick={handleCreate} className="btn-dark shrink-0" disabled={creating}>
                + 新規ゴール
              </button>
            )}
          </div>
        </div>
        <p className="text-[13px] text-[var(--muted)] mb-6 cjk">
          {admin
            ? "番号付きのゴールと、その下のタスク（クリックで中へ）"
            : "あなたのタスク"}
        </p>

        <MyTurn />
        <DoneCounts myEmail={myEmail} />

        {/* PC(lg+): 左=ゴールツリー / 右=期限が近い。スマホは期限が近い→ツリーの縦1列 */}
        <div className="lg:flex lg:gap-8 lg:items-start">
        <div className="lg:hidden">
        {upcomingDeadlines.length > 0 && (
          <div className="card px-4 py-1 mb-6 divide-y divide-[var(--border)]">
            <button type="button" onClick={toggleDeadlines} aria-expanded={!deadlinesClosed} className="flex w-full items-center gap-1.5 py-2 text-left text-[13px] font-semibold text-[var(--muted)] cjk">
              <Chevron closed={deadlinesClosed} />
              期限が近い
              <span className="font-normal text-[var(--muted-soft)]">{upcomingDeadlines.length}</span>
            </button>
            {!deadlinesClosed && upcomingDeadlines.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => router.push(`/goals/${g.id}`)}
                onMouseEnter={() => prefetchGoalBundle(g.id)}
                className="flex items-center gap-2 w-full text-left py-2.5 hover:bg-[var(--hover)]"
              >
                {g.emoji && <span className="shrink-0">{g.emoji}</span>}
                <span className="flex-1 min-w-0 break-words text-[14px] cjk text-[var(--foreground)]">{g.name || "（無題）"}</span>
                <span
                  className="shrink-0 text-[12.5px] font-medium"
                  style={{ color: g.daysLeft < 0 ? "#dc2626" : g.daysLeft <= 2 ? "#d97706" : "var(--muted)" }}
                >
                  {g.daysLeft < 0 ? `期限切れ ${Math.abs(g.daysLeft)}日` : g.daysLeft === 0 ? "今日まで" : `あと${g.daysLeft}日`}
                </span>
              </button>
            ))}
          </div>
        )}

        </div>
        <div className="min-w-0 flex-1">
        {admin === null || loading ? (
          <div className="py-8 text-[14px] text-[var(--muted)]">読み込み中…</div>
        ) : tree.length === 0 && doneItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-4 py-20">
            <span className="w-12 h-12 rounded-2xl border-2 border-dashed flex items-center justify-center" style={{ borderColor: "var(--border-strong)", color: "var(--muted-soft)" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>
            </span>
            {admin ? (
              <>
                <p className="text-[15px] text-[var(--muted-soft)] cjk max-w-sm">
                  まだゴールがありません。最初のゴールを作成しましょう。
                </p>
                <button onClick={handleCreate} className="btn-dark" disabled={creating}>
                  + ゴールを作成
                </button>
              </>
            ) : (
              <p className="text-[15px] text-[var(--muted-soft)] cjk max-w-sm">
                まだタスクがありません。管理者からタスクをもらってください。
              </p>
            )}
          </div>
        ) : (
          <>
            {tree.length > 0 && (
              <div className="card px-3 md:px-5 py-1 divide-y divide-[var(--border)]">
                {tree.map((n, i) => (
                  <ItemRow
                    key={n.id}
                    node={n}
                    depth={0}
                    index={i + 1}
                    indent={indent}
                    members={members}
                    stats={stats}
                    doneShown={doneShown}
                    onToggleDoneChildren={toggleDoneChildren}
                    collapsed={collapsed}
                    canEdit={admin === true || scoped}
                    operableIds={operableIds}
                    parentId={null}
                    outdentTargetId={undefined}
                    indentTargetId={i > 0 ? tree[i - 1].id : undefined}
                    dragId={dragId}
                    dropHint={dropHint}
                    onToggleCollapse={toggleCollapse}
                    onOpen={(id) => router.push(`/goals/${id}`)}
                    onAddChild={handleAddChild}
                    onArchive={handleArchive}
                    onToggleDone={handleToggleDone}
                    onStart={handleStart}
                    onMove={handleMove}
                    onDragStartRow={onDragStartRow}
                    onDragEndRow={onDragEndRow}
                    onDragOverRow={onDragOverRow}
                    onDropRow={onDropRow}
                  />
                ))}
              </div>
            )}

            {/* ゴールにぶら下がっていない完了。ツリーに出しても位置が無く、数だけ多いので
                ここに畳んで置く。ゴールの中の完了は「完了を表示」でその場に出る */}
            {doneItems.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setDoneOpen((v) => !v)}
                  className="flex items-center gap-1.5 w-full text-left text-[13px] font-semibold text-[var(--muted)] hover:text-[var(--foreground)] transition-colors py-1.5 cjk"
                  aria-expanded={doneOpen}
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="w-3 h-3 flex-shrink-0 transition-transform"
                    style={{ transform: doneOpen ? "rotate(90deg)" : "none" }}
                    fill="currentColor"
                  >
                    <path d="M6 3l5 5-5 5V3z" />
                  </svg>
                  完了（どのゴールにも紐づいていない）({doneItems.length})
                </button>

                {doneOpen && (
                  <div className="card px-3 md:px-5 py-1 divide-y divide-[var(--border)] mt-1.5">
                    {doneItems.map((it) => {
                      const st = stats.get(it.id);
                      return (
                      <div key={it.id} className="done-row flex items-center gap-2.5 py-2 rounded-lg">
                        {/* 緑のチェック → 押すと未完了に戻る */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleDone(it.id, false);
                          }}
                          className="w-5 h-5 shrink-0 rounded-md border flex items-center justify-center transition-colors"
                          style={{ background: "var(--done)", borderColor: "var(--done)" }}
                          aria-label="未完了に戻す"
                          title="未完了に戻す"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        </button>
                        {/* name → drill in */}
                        <button
                          type="button"
                          onClick={() => router.push(`/goals/${it.id}`)}
                          className="min-w-0 break-words text-left text-[14px] cjk hover:underline done-label"
                        >
                          {it.emoji && <span className="mr-1.5">{it.emoji}</span>}
                          {it.name || "（無題）"}
                        </button>
                        {st && st.total > 0 && (
                          <span className={`done-badge shrink-0 ${st.done === st.total ? "is-all" : st.done === 0 ? "is-none" : ""}`}>
                            完了 {st.done}/{st.total}
                          </span>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        </div>
        {upcomingDeadlines.length > 0 && (
          <aside className="hidden lg:block w-80 shrink-0 lg:sticky lg:top-6">
                  <div className="card px-4 py-1 mb-6 lg:mb-0 divide-y divide-[var(--border)]">
            <button type="button" onClick={toggleDeadlines} aria-expanded={!deadlinesClosed} className="flex w-full items-center gap-1.5 py-2 text-left text-[13px] font-semibold text-[var(--muted)] cjk">
              <Chevron closed={deadlinesClosed} />
              期限が近い
              <span className="font-normal text-[var(--muted-soft)]">{upcomingDeadlines.length}</span>
            </button>
            {!deadlinesClosed && upcomingDeadlines.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => router.push(`/goals/${g.id}`)}
                onMouseEnter={() => prefetchGoalBundle(g.id)}
                className="flex items-center gap-2 w-full text-left py-2.5 hover:bg-[var(--hover)]"
              >
                {g.emoji && <span className="shrink-0">{g.emoji}</span>}
                <span className="flex-1 min-w-0 break-words text-[14px] cjk text-[var(--foreground)]">{g.name || "（無題）"}</span>
                <span
                  className="shrink-0 text-[12.5px] font-medium"
                  style={{ color: g.daysLeft < 0 ? "#dc2626" : g.daysLeft <= 2 ? "#d97706" : "var(--muted)" }}
                >
                  {g.daysLeft < 0 ? `期限切れ ${Math.abs(g.daysLeft)}日` : g.daysLeft === 0 ? "今日まで" : `あと${g.daysLeft}日`}
                </span>
              </button>
            ))}
          </div>
          </aside>
        )}
        </div>
      </div>
    </div>
  );
}
