"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { getGoal, updateGoal, archiveGoal, createResource, getMe, listMembers, createChild, toggleItemDone, setItemStarted, getGoalBundle, cachedGoalBundle, prefetchGoalBundle, createTemplateFromGoal, type GoalBundle } from "../../lib/addness";
import type { Goal, Resource, Member, ChatMessage } from "../../lib/db";
import type { Me, GoalMember } from "../../lib/addness";
import Linkified from "../../components/Linkified";
import AgentLaunch from "../../components/AgentLaunch";
import AutoGrowTextarea from "../../components/AutoGrowTextarea";
import { I } from "../../components/goal/Icon";
import { SubTree } from "../../components/goal/SubTree";
import { ResourceItem } from "../../components/goal/ResourceItem";
import { CommentsPanel } from "../../components/goal/CommentsPanel";
import { AssignPanel } from "../../components/goal/AssignPanel";
import { MetaSection } from "../../components/goal/MetaSection";
import { InProgressBadge, StartButton, TaskCheck, isInProgress } from "../../components/InProgress";
import { Assignees } from "../../components/Assignees";
import { useAutoRefresh } from "../../lib/useAutoRefresh";

const PLACEHOLDER = "ここをタップして、達成したいゴールを入力しましょう！";

export default function GoalDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id as string;
  const router = useRouter();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [title, setTitle] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [resources, setResources] = useState<Resource[]>([]);
  const [showMeta, setShowMeta] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [menu, setMenu] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [assignees, setAssignees] = useState<GoalMember[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  // recursive child items (subtasks == child goals)
  const [ancestors, setAncestors] = useState<{ id: string; name: string }[]>([]);
  const [children, setChildren] = useState<Goal[]>([]);
  const [showDoneChildren, setShowDoneChildren] = useState(false);
  const [childAssignees, setChildAssignees] = useState<Record<string, GoalMember[]>>({});
  const [childProgress, setChildProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [expandedTop, setExpandedTop] = useState<Set<string>>(new Set());
  const toggleExpandTop = (cid: string) =>
    setExpandedTop((p) => { const n = new Set(p); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });
  const [editingChild, setEditingChild] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const editRef = useRef<HTMLInputElement | null>(null);

  // comments
  const [comments, setComments] = useState<ChatMessage[]>([]);
  // true = the next applyBundle is "just opened/switched goal" data, not a
  // live update — record the baseline but don't yank the view to the bottom.
  const suppressNextCommentScrollRef = useRef(true);

  // one bundle request refreshes everything on this page (title is left alone
  // so an in-progress rename isn't clobbered)
  const applyBundle = useCallback((b: GoalBundle, opts?: { withTitle?: boolean }) => {
    setGoal(b.goal);
    if (opts?.withTitle) { setTitle(b.goal.name || ""); setShowMeta(false); setShowResources(false); }
    setAncestors(b.ancestors);
    setChildren(b.children);
    setChildAssignees(b.childAssignees);
    setChildProgress(b.childProgress);
    setResources(b.resources);
    setComments(b.comments);
    setAssignees(b.assignees);
  }, []);
  const refreshBundle = useCallback(async () => {
    try { applyBundle(await getGoalBundle(id)); } catch { /* tolerate */ }
  }, [id, applyBundle]);

  const loadResources = refreshBundle;
  const [bulkOpen, setBulkOpen] = useState<{ open: boolean; token: number }>({ open: false, token: 0 });
  const toggleBulkOpen = () => setBulkOpen((p) => ({ open: !p.open, token: p.token + 1 }));
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) { window.alert("ファイルは25MBまで。"); return; }
    // file + memo は必ずペア — 空のまま/キャンセルではアップロードしない。
    let caption = "";
    while (true) {
      const raw = window.prompt("このファイルは何のファイルですか?(必須)");
      if (raw === null) return; // cancelled entirely
      caption = raw.trim();
      if (caption) break;
      window.alert("説明を入力してください。");
    }
    try {
      const r = await fetch("/api/files", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": f.type || "application/octet-stream",
          "x-goal-id": id,
          "x-filename": encodeURIComponent(f.name),
          ...(caption ? { "x-caption": encodeURIComponent(caption) } : {}),
        },
        body: f,
      });
      if (!r.ok) throw new Error(await r.text().catch(() => "upload failed"));
      window.dispatchEvent(new Event("kotsukotsu:mutated"));
      loadResources();
    } catch (err) { console.error(err); window.alert("アップロードに失敗しました"); }
  };
  const onAddLink = async () => {
    const rawUrl = window.prompt("URLを入力してください");
    const url = rawUrl?.trim();
    if (!url) return;
    // link + memo は必ずペア。
    let memo = "";
    while (true) {
      const raw = window.prompt("このリンクは何ですか?(必須)");
      if (raw === null) return;
      memo = raw.trim();
      if (memo) break;
      window.alert("説明を入力してください。");
    }
    let title = url;
    try { title = new URL(url).hostname; } catch { /* not a full URL; use as-is */ }
    try { await createResource(id, title, "link", { url, content: memo }); loadResources(); } catch { window.alert("追加に失敗しました"); }
  };

  const loadAssignees = refreshBundle;
  const ensureMembers = useCallback(async () => {
    try { setMembers((await listMembers()).filter((m) => !m.is_ai)); } catch {}
  }, []);
  const loadComments = refreshBundle;
  const loadChildren = refreshBundle;

  useEffect(() => {
    let alive = true;
    // just switched goals — the next one or two bundle applies are the
    // opening view of this goal, not a live update, so don't scroll for them
    suppressNextCommentScrollRef.current = true;
    // paint instantly from cache (hover-prefetch / earlier visit), then refresh
    const cached = cachedGoalBundle(id);
    if (cached) applyBundle(cached, { withTitle: true });
    (async () => {
      try {
        const b = await getGoalBundle(id);
        if (!alive) return;
        suppressNextCommentScrollRef.current = true;
        applyBundle(b, { withTitle: !cached });
      } catch { if (alive && !cached) setNotFound(true); }
    })();
    (async () => {
      try { const { user } = await getMe(); if (alive) setMe(user); } catch {}
    })();
    return () => { alive = false; };
  }, [id, applyBundle]);

  useEffect(() => {
    if (editingChild && editRef.current) { editRef.current.focus(); editRef.current.select(); }
  }, [editingChild]);

  // keep this goal fresh (children/comments/resources/status) on focus + interval.
  // does NOT touch the title field so an in-progress rename isn't clobbered.
  const reloadAll = refreshBundle;
  useAutoRefresh(reloadAll);

  const saveTitle = useCallback(async () => {
    if (!goal) return;
    const v = title.trim();
    if (v === goal.name) return;
    try { await updateGoal(id, { name: v }); setGoal({ ...goal, name: v }); } catch (e) { console.error(e); }
  }, [goal, title, id]);

  const patch = useCallback(async (p: Partial<Goal>) => {
    if (!goal) return;
    setGoal({ ...goal, ...p });
    try { await updateGoal(id, p); } catch (e) { console.error(e); }
  }, [goal, id]);

  // toggle THIS item's completion
  const toggleSelfDone = useCallback(async (done: boolean) => {
    if (!goal) return;
    setGoal({ ...goal, status: done ? "done" : "active" });
    try {
      await toggleItemDone(id, done);
      const g = await getGoal(id);
      if (g) { setGoal(g); setTitle(g.name || ""); }
    } catch (e) { console.error(e); }
  }, [goal, id]);

  // 「開始」。押した人が開始した人として残る。取り消しは押し間違い用
  const toggleSelfStarted = useCallback(async (started: boolean) => {
    if (!goal) return;
    setGoal({ ...goal, started_at: started ? new Date().toISOString() : null, started_by_name: started ? (me?.name || me?.email || null) : null, started_via: started ? "app" : null });
    try {
      await setItemStarted(id, started);
      const g = await getGoal(id);
      if (g) setGoal(g);
    } catch (e) { console.error(e); }
  }, [goal, id, me]);

  const canManage = me?.role === "admin" || (!!goal?.created_by && goal?.created_by === me?.id);

  // メンバー一覧はページを開いた時点で読み込む。以前はアサインパネルを
  // 開くまで空のままで、@メンション候補に「全員」しか出なかった。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = (await listMembers()).filter((m) => !m.is_ai);
        if (alive && list.length > 0) setMembers(list);
      } catch { /* tolerate — アサインパネルを開いた時に再取得する */ }
    })();
    return () => { alive = false; };
  }, []);


  // ----- child item actions -----
  const toggleChildDone = useCallback(async (childId: string, done: boolean) => {
    setChildren((cs) => cs.map((c) => (c.id === childId ? { ...c, status: done ? "done" : "active" } : c)));
    try { await toggleItemDone(childId, done); } catch (e) { console.error(e); }
    loadChildren();
  }, [loadChildren]);

  const startChild = useCallback(async (childId: string, started: boolean) => {
    setChildren((cs) => cs.map((c) => (c.id === childId ? { ...c, started_at: started ? new Date().toISOString() : null, started_by_name: started ? (me?.name || me?.email || null) : null, started_via: started ? "app" : null } : c)));
    try { await setItemStarted(childId, started); } catch (e) { console.error(e); }
    loadChildren();
  }, [loadChildren, me]);

  const addChild = useCallback(async () => {
    try {
      const c = await createChild(id);
      await loadChildren();
      setEditingChild(c.id);
      setEditName(c.name || "");
    } catch (e) { console.error(e); }
  }, [id, loadChildren]);

  const deleteChild = useCallback(async (childId: string) => {
    if (!window.confirm("このタスクを削除しますか?")) return;
    try { await archiveGoal(childId); await loadChildren(); } catch (e) { console.error(e); }
  }, [loadChildren]);

  const commitEdit = useCallback(async (childId: string) => {
    const v = editName.trim();
    setEditingChild(null);
    setChildren((cs) => cs.map((c) => (c.id === childId ? { ...c, name: v } : c)));
    try { await updateGoal(childId, { name: v }); } catch (e) { console.error(e); }
  }, [editName]);


  if (notFound) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-[var(--muted)]">
          <p className="mb-3">ゴールが見つかりません</p>
          <button onClick={() => router.push("/")} className="btn-dark">タスク一覧へ</button>
        </div>
      </div>
    );
  }
  if (!goal) return <div className="flex items-center justify-center h-full text-[var(--muted-soft)]">読み込み中…</div>;

  const renderChildRow = (c: Goal) => {
    const done = c.status === "done";
    const prog = childProgress[c.id];
    const ass = childAssignees[c.id] ?? [];
    const editing = editingChild === c.id;
    return (
      <li key={c.id} className="border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <div className={`flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--hover)] group${done ? " done-row" : ""}`} onMouseEnter={() => prefetchGoalBundle(c.id)}>
        {/* expand toggle — visible when this task has sub-tasks */}
        {prog && prog.total > 0 ? (
          <button
            onClick={() => toggleExpandTop(c.id)}
            className="w-4 h-4 -ml-1 shrink-0 flex items-center justify-center text-[var(--muted-soft)] hover:text-[var(--foreground)]"
            aria-label={expandedTop.has(c.id) ? "折りたたむ" : "展開"}
            aria-expanded={expandedTop.has(c.id)}
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3 transition-transform" style={{ transform: expandedTop.has(c.id) ? "rotate(90deg)" : "none" }} fill="currentColor"><path d="M6 3l5 5-5 5V3z" /></svg>
          </button>
        ) : (
          <span className="w-4 h-4 -ml-1 shrink-0" aria-hidden />
        )}
        {/* done checkbox */}
        <TaskCheck t={c} onToggle={(d) => toggleChildDone(c.id, d)} onStop={() => startChild(c.id, false)} parent={!!prog && prog.total > prog.done} />
        {/* name */}
        {editing ? (
          <input
            ref={editRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={() => commitEdit(c.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commitEdit(c.id); addChild(); }
              else if (e.key === "Escape") { e.preventDefault(); setEditingChild(null); }
            }}
            placeholder="新しいタスク"
            className="flex-1 min-w-0 bg-transparent text-[14.5px] focus:outline-none border-b"
            style={{ borderColor: "var(--accent)" }}
          />
        ) : (
          <button
            onClick={() => router.push(`/goals/${c.id}`)}
            className={`flex-1 min-w-0 text-left text-[14.5px] break-words hover:underline ${done ? "done-label" : ""}`}
            title={c.name}
          >
            {c.name || "無題のタスク"}
          </button>
        )}
        {/* sub-children progress pill */}
        {prog && prog.total > 0 && (
          <span
            className={`done-badge shrink-0 ${prog.done === prog.total ? "is-all" : prog.done === 0 ? "is-none" : ""}`}
            title={`このタスクの下: ${prog.total} 件中 ${prog.done} 件が完了`}
          >
            完了 {prog.done}/{prog.total}
          </span>
        )}
        {/* 進行中の印 / 未着手なら「開始」(PC はホバー時だけ。スマホはタスクを開いた先のボタンで) */}
        <InProgressBadge t={c} wrapClass="hidden sm:inline-flex" parent={!!prog && prog.total > prog.done} />
        {!editing && <StartButton t={c} parent={!!prog && prog.total > prog.done} onToggle={(on) => startChild(c.id, on)} wrapClass="hidden lg:inline-flex lg:opacity-0 lg:group-hover:opacity-100" />}
        {/* assignee avatars */}
        <Assignees members={ass} size={22} max={3} />
        {/* delete */}
        {!editing && (
          <button onClick={() => deleteChild(c.id)} className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--danger)]" aria-label="タスクを削除"><I d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></button>
        )}
        {/* chevron (navigate in) */}
        {!editing && (
          <button onClick={() => router.push(`/goals/${c.id}`)} className="shrink-0 text-[var(--muted-soft)] group-hover:text-[var(--muted)]" aria-label="中に入る"><I d="M9 18l6-6-6-6" /></button>
        )}
      </div>
      {expandedTop.has(c.id) && (
        <ul><SubTree parentId={c.id} depth={1} router={router} /></ul>
      )}
      </li>
    );
  };

  return (
    <div className="min-h-full bg-white">
      <div className="max-w-3xl lg:max-w-[1360px] mx-auto px-4 md:px-10 py-7 pb-24 md:pb-7">
        {/* breadcrumb + actions */}
        <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
          <nav className="flex items-center gap-1 text-[13px] text-[var(--muted)] min-w-0 flex-wrap">
            <button onClick={() => router.push("/")} className="hover:text-[var(--foreground)] flex items-center gap-1 shrink-0">
              <I d="M15 18l-6-6 6-6" />タスク
            </button>
            {ancestors.map((a, i) => {
              const isLast = i === ancestors.length - 1;
              return (
                <span key={a.id} className="flex items-center gap-1 min-w-0">
                  <span className="text-[var(--muted-soft)] shrink-0">›</span>
                  {isLast ? (
                    <span className="font-bold text-[var(--foreground)] truncate max-w-[14rem]" title={a.name}>{a.name || "無題"}</span>
                  ) : (
                    <button onClick={() => router.push(`/goals/${a.id}`)} className="hover:text-[var(--foreground)] truncate max-w-[10rem]" title={a.name}>{a.name || "無題"}</button>
                  )}
                </span>
              );
            })}
          </nav>
          <div className="flex items-center gap-2 shrink-0">
            <label className="chip cursor-pointer">
              <I d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
              <input type="date" value={goal.deadline ?? ""} onChange={(e) => patch({ deadline: e.target.value || null })}
                className="bg-transparent text-[12.5px] focus:outline-none" style={{ width: goal.deadline ? 110 : 64 }} />
              {!goal.deadline && <span>期日</span>}
            </label>
            <AssignPanel goalId={id} assignees={assignees} members={members} canManage={canManage} loadAssignees={loadAssignees} ensureMembers={ensureMembers} />
            <div className="relative">
              <button onClick={() => setMenu((v) => !v)} className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)]" aria-label="メニュー"><I d="M5 12h.01M12 12h.01M19 12h.01" /></button>
              {menu && (
                <div className="absolute right-0 top-9 z-20 card py-1 w-44" style={{ boxShadow: "var(--shadow-pop)" }} onMouseLeave={() => setMenu(false)}>
                  {/* このゴールのタスク木を写して「型」にする。型は /templates でメンバーに振れる */}
                  {canManage && (
                    <button
                      onClick={async () => {
                        setMenu(false);
                        try {
                          const t = await createTemplateFromGoal(id);
                          router.push(`/templates/${t.id}`);
                        } catch (e) { console.error(e); }
                      }}
                      className="block w-full text-left px-4 py-2 text-sm hover:bg-[var(--hover)]"
                    >型にする</button>
                  )}
                  <button onClick={async () => { await archiveGoal(id); router.push("/"); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-[var(--hover)] text-[var(--danger)]">アーカイブ</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* PC(lg+): 左=目標・タスク・リソース / 右=コメント固定パネル。スマホは従来どおり縦1列 */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px] lg:gap-8 lg:items-start">
        <div className="min-w-0">
        {/* ===== 大ゴール (editable) ===== */}
        {(() => {
          const selfDone = goal.status === "done";
          return (
        <div className="rounded-2xl border px-5 py-4 mb-4" style={{ borderColor: "var(--border)", background: "#fafafa", borderLeft: `4px solid ${selfDone ? "var(--done)" : "var(--accent)"}` }}>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-1">
            <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide whitespace-nowrap" style={{ color: selfDone ? "var(--done-strong)" : "var(--accent)" }}>
              <I d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 12l3 2" />大ゴール（クリックで編集）
              {goal.template_id && (
                <button type="button" onClick={() => router.push(`/templates/${goal.template_id}`)} className="ml-2 chip" style={{ fontSize: 11, padding: "1px 8px" }} title="この型から作られたゴール">型から作成</button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
            {/* Claude / Codex をこのゴールの指示文入りで開く */}
            <AgentLaunch goalId={id} goalName={goal.name} />
            {selfDone ? (
              <div className="flex items-center gap-2 shrink-0">
                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold text-white" style={{ background: "var(--done)" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  完了
                </span>
                <button onClick={() => toggleSelfDone(false)} className="text-[12px] text-[var(--muted)] hover:text-[var(--foreground)] underline underline-offset-2">完了を取り消す</button>
              </div>
            ) : (
              <>
              <StartButton t={goal} parent={children.some((c) => c.status === "active")} onToggle={toggleSelfStarted} className="start-btn-md" />
              <button
                onClick={() => toggleSelfDone(true)}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-bold text-white hover:opacity-90 transition-opacity"
                style={{ background: "var(--accent)" }}
                aria-label="このゴールを完了にする"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                完了にする
              </button>
              </>
            )}
            </div>
          </div>
          <div className="flex items-start gap-2">
            {selfDone && (
              <span className="mt-2.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "var(--done)" }} title="完了">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              </span>
            )}
            <AutoGrowTextarea
              minRows={1}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              rows={1}
              placeholder={PLACEHOLDER}
              style={{ fontSize: title.length > 90 ? 16 : title.length > 60 ? 18 : title.length > 32 ? 21 : 24 }}
              className={`w-full resize-none bg-transparent font-bold leading-snug focus:outline-none placeholder:text-[var(--muted-soft)] placeholder:font-normal ${selfDone ? "text-[var(--muted)]" : ""}`}
            />
          </div>
          {isInProgress(goal) && !children.some((c) => c.status === "active") && (
            <div className="flex items-center gap-2 mt-1.5 min-w-0">
              <InProgressBadge t={goal} detail parent={children.some((c) => c.status === "active")} />
            </div>
          )}
        </div>
          );
        })()}

        <MetaSection goal={goal} showMeta={showMeta} setShowMeta={setShowMeta} patch={patch} />

        {/* ===== タスク (recursive child items) ===== */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2 gap-3">
            <h3 className="shrink-0 whitespace-nowrap text-[16px] font-bold flex items-center gap-2">
              <I d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />タスク
            </h3>
            <span className="hidden sm:inline text-[11.5px] text-[var(--muted-soft)]">クリックで中に入れます（タスクの中にさらにタスク）</span>
          </div>
          <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
            {children.length === 0 && editingChild === null ? (
              <div className="px-4 py-8 text-center text-[13px] text-[var(--muted-soft)]">まだタスクがありません</div>
            ) : (
              <ul>{(showDoneChildren ? children : children.filter((c) => c.status !== "done")).map(renderChildRow)}</ul>
            )}
            {children.some((c) => c.status === "done") && (
              <button
                type="button"
                onClick={() => setShowDoneChildren((v) => !v)}
                className="flex items-center gap-1.5 w-full px-4 py-2 text-left text-[12.5px] font-semibold hover:bg-[var(--hover)] border-t"
                style={{ borderColor: "var(--border)", color: showDoneChildren ? "var(--done-strong)" : "var(--muted)" }}
                aria-expanded={showDoneChildren}
              >
                <svg viewBox="0 0 16 16" className="w-3 h-3 flex-shrink-0 transition-transform" style={{ transform: showDoneChildren ? "rotate(90deg)" : "none" }} fill="currentColor"><path d="M6 3l5 5-5 5V3z" /></svg>
                {showDoneChildren
                  ? `完了を隠す (${children.filter((c) => c.status === "done").length})`
                  : `完了を表示 (${children.filter((c) => c.status === "done").length})`}
              </button>
            )}
            <button onClick={addChild} className="flex items-center gap-2 w-full px-4 py-2.5 text-[13.5px] text-[var(--muted)] hover:bg-[var(--hover)] border-t" style={{ borderColor: "var(--border)" }}>
              <I d="M12 5v14M5 12h14" />タスクを追加
            </button>
          </div>
        </div>

        {/* ===== リソース ===== */}
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setShowResources((v) => !v)}
            aria-expanded={showResources}
            className="text-[16px] font-bold mb-3 flex items-center gap-2 hover:opacity-80"
          >
            <span style={{ display: "inline-flex", transform: showResources ? undefined : "rotate(-90deg)", transition: "transform .15s" }}><I d="M6 9l6 6 6-6" /></span>
            リソース
            <span className="text-[13px] font-normal text-[var(--muted)]">{resources.length}</span>
          </button>
          {showResources && (
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
              <div className="text-[13px] text-[var(--muted)]">{resources.length} 件の成果物</div>
              <div className="flex items-center gap-2">
                {resources.length > 0 && (
                  <button onClick={toggleBulkOpen} className="chip">{bulkOpen.open ? "すべて閉じる" : "すべてプレビュー"}</button>
                )}
                <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
                <button onClick={() => fileRef.current?.click()} className="chip"><I d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49" />ファイル+メモ</button>
                <button onClick={onAddLink} className="chip"><I d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />リンク+メモ</button>
              </div>
            </div>
            {resources.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-12 h-12 rounded-xl border-2 border-dashed flex items-center justify-center mb-3" style={{ borderColor: "var(--border-strong)", color: "var(--muted-soft)" }}>
                  <I d="M12 19V5M5 12l7-7 7 7" />
                </div>
                <div className="text-sm text-[var(--muted)]">成果物がありません</div>
                <div className="text-xs text-[var(--muted-soft)] mt-1">ファイル+メモ、またはリンク+メモを追加できます</div>
              </div>
            ) : (
              <ul>
                {resources.map((r) => (
                  <ResourceItem key={r.id} r={r} onChanged={loadResources} bulkOpen={bulkOpen} />
                ))}
              </ul>
            )}
          </div>
          )}
        </div>

        </div>

        <CommentsPanel goalId={id} comments={comments} setComments={setComments} loadComments={loadComments} me={me} members={members} assignees={assignees} suppressNextCommentScrollRef={suppressNextCommentScrollRef} />
        </div>
      </div>
    </div>
  );
}
