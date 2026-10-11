"use client";

// ゴール詳細のタスク行の下に開く、遅延読み込みのサブタスク木。app/goals/[id]/page.tsx から切り出し。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listChildren, listGoalMembersBatch, toggleItemDone, setItemStarted, prefetchGoalBundle, type GoalMember } from "../../lib/addness";
import type { Goal } from "../../lib/db";
import { InProgressBadge, TaskCheck } from "../InProgress";
import { Assignees } from "../Assignees";

// Lazy, collapsible subtask tree shown inline under a goal-page task row.
export function SubTree({ parentId, depth, router }: { parentId: string; depth: number; router: ReturnType<typeof useRouter> }) {
  const [kids, setKids] = useState<Goal[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const [kidAssignees, setKidAssignees] = useState<Record<string, GoalMember[]>>({});
  useEffect(() => {
    let alive = true;
    listChildren(parentId).then((k) => {
      if (!alive) return;
      setKids(k);
      // 担当者アイコンは一段深いサブタスクにも出す(誰が持っているか見えないと
      // ツリーを開いた意味がない)。1リクエストでまとめて取る。
      if (k.length) {
        listGoalMembersBatch(k.map((x) => x.id))
          .then((by) => { if (alive) setKidAssignees(by); })
          .catch(() => { /* tolerate */ });
      }
    }).catch(() => { if (alive) setKids([]); });
    return () => { alive = false; };
  }, [parentId]);
  const toggle = (cid: string) => setOpen((p) => { const n = new Set(p); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });
  const stopKid = async (cid: string) => {
    setKids((ks) => (ks ? ks.map((k) => (k.id === cid ? { ...k, started_at: null, started_by_name: null, started_via: null } : k)) : ks));
    try { await setItemStarted(cid, false); } catch { /* tolerate */ }
  };
  const toggleDone = async (cid: string, done: boolean) => {
    setKids((ks) => (ks ? ks.map((k) => (k.id === cid ? { ...k, status: done ? "done" : "active" } : k)) : ks));
    try { await toggleItemDone(cid, done); } catch { /* tolerate */ }
  };
  const pad = 16 + depth * 18;
  if (kids === null) return <li className="px-4 py-2 text-[12px] text-[var(--muted-soft)]" style={{ paddingLeft: pad }}>読み込み中…</li>;
  if (kids.length === 0) return <li className="px-4 py-2 text-[12px] text-[var(--muted-soft)]" style={{ paddingLeft: pad }}>サブタスクなし</li>;
  const doneKids = kids.filter((k) => k.status === "done");
  const renderRow = (k: Goal) => {
    const done = k.status === "done";
    const isOpen = open.has(k.id);
    return (
      <li key={k.id} className="border-b last:border-0" style={{ borderColor: "var(--border)" }}>
        <div className={`flex items-center gap-2.5 py-2 pr-4 hover:bg-[var(--hover)]${done ? " done-row" : ""}`} style={{ paddingLeft: pad }} onMouseEnter={() => prefetchGoalBundle(k.id)}>
          <button onClick={() => toggle(k.id)} className="w-4 h-4 -ml-1 shrink-0 flex items-center justify-center text-[var(--muted-soft)] hover:text-[var(--foreground)]" aria-label={isOpen ? "折りたたむ" : "展開"} aria-expanded={isOpen}>
            <svg viewBox="0 0 16 16" className="w-3 h-3 transition-transform" style={{ transform: isOpen ? "rotate(90deg)" : "none" }} fill="currentColor"><path d="M6 3l5 5-5 5V3z" /></svg>
          </button>
          <TaskCheck t={k} onToggle={(d) => toggleDone(k.id, d)} onStop={() => stopKid(k.id)} />
          <button onClick={() => router.push(`/goals/${k.id}`)} className={`flex-1 min-w-0 text-left text-[14px] break-words hover:underline ${done ? "done-label" : ""}`} title={k.name}>{k.name || "無題のタスク"}</button>
          <InProgressBadge t={k} wrapClass="hidden sm:inline-flex" />
          <Assignees members={kidAssignees[k.id] ?? []} size={22} max={3} />
        </div>
        {isOpen && <ul><SubTree parentId={k.id} depth={depth + 1} router={router} /></ul>}
      </li>
    );
  };
  // 完了を出すときは、まとめて下に落とさず元の並びのまま差し込む。
  // 「どのタスクの隣の何が終わったのか」は順番が崩れると分からなくなる。
  return (
    <>
      {(showDone ? kids : kids.filter((k) => k.status !== "done")).map(renderRow)}
      {doneKids.length > 0 && (
        <li className="border-b last:border-0" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="flex items-center gap-1.5 w-full text-left text-[12.5px] font-semibold hover:opacity-80 transition-opacity py-2 pr-4"
            style={{ paddingLeft: pad, color: showDone ? "var(--done-strong)" : "var(--muted)" }}
            aria-expanded={showDone}
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3 flex-shrink-0 transition-transform" style={{ transform: showDone ? "rotate(90deg)" : "none" }} fill="currentColor"><path d="M6 3l5 5-5 5V3z" /></svg>
            {showDone ? `完了を隠す (${doneKids.length})` : `完了を表示 (${doneKids.length})`}
          </button>
        </li>
      )}
    </>
  );
}
