"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { Avatar } from "./components/Assignees";
import { InProgressBadge, StartButton, TaskCheck } from "./components/InProgress";

type ItemNode = Goal & { children: ItemNode[] };
type DropPos = "before" | "after" | "inside"; // drag-drop placement relative to a row
type DropHint = { id: string; pos: DropPos } | null;

// days from today to a "YYYY-MM-DD" deadline (negative = overdue)
function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

const INDENT = 28; // px per depth level (desktop)
const INDENT_MOBILE = 16; // px per depth level (narrow screens)
const NAVY = "#1e2a78"; // dark navy for top-level number circles
const LINE = "#d7d8db"; // light gray connector lines

// responsive per-depth indent: smaller on phones so deep rows don't overflow
function useIndent(): number {
  const [indent, setIndent] = useState(INDENT);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () => setIndent(mq.matches ? INDENT : INDENT_MOBILE);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return indent;
}

type ChildStats = { done: number; total: number };

// 直下の子の「完了 / 全体」を数える。完了を隠している状態でも、親の行を見れば
// この下が何件中何件終わったのかが分かるようにするための集計。
function countChildren(items: Goal[]): Map<string, ChildStats> {
  const m = new Map<string, ChildStats>();
  for (const it of items) {
    const p = it.parent_goal_id;
    if (!p) continue;
    const s = m.get(p) ?? { done: 0, total: 0 };
    s.total += 1;
    if (it.status === "done") s.done += 1;
    m.set(p, s);
  }
  return m;
}

// build a tree from a flat list of items via parent_goal_id
function buildItemTree(items: Goal[]): ItemNode[] {
  const byId = new Map<string, ItemNode>();
  for (const it of items) byId.set(it.id, { ...it, children: [] });
  const roots: ItemNode[] = [];
  for (const it of items) {
    const node = byId.get(it.id)!;
    const parent = it.parent_goal_id ? byId.get(it.parent_goal_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// Prune the full goal list down to what an assigned member should see:
// their assigned goals + everything under them (operable), plus the ancestor
// chain up to the root (read-only context, so they see what it connects to).
// Unrelated branches are dropped. `operable` = assigned subtree (editable area);
// the rest of `visible` is context. Returns null operable for full-tree viewers.
function pruneToAssigned(all: Goal[], assignedIds: Set<string>): { visible: Goal[]; operable: Set<string> } {
  const byId = new Map(all.map((g) => [g.id, g]));
  const childrenOf = new Map<string, string[]>();
  for (const g of all) {
    if (!g.parent_goal_id) continue;
    const arr = childrenOf.get(g.parent_goal_id);
    if (arr) arr.push(g.id);
    else childrenOf.set(g.parent_goal_id, [g.id]);
  }
  // operable = assigned nodes + their descendants
  const operable = new Set<string>();
  const stack: string[] = [];
  for (const id of assignedIds) if (byId.has(id)) { operable.add(id); stack.push(id); }
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of childrenOf.get(id) ?? []) if (!operable.has(c)) { operable.add(c); stack.push(c); }
  }
  // keep = operable + ancestor chain (context) up to the root
  const keep = new Set(operable);
  for (const id of operable) {
    let cur = byId.get(id)?.parent_goal_id ?? null;
    while (cur && !keep.has(cur)) { keep.add(cur); cur = byId.get(cur)?.parent_goal_id ?? null; }
  }
  return { visible: all.filter((g) => keep.has(g.id)), operable };
}

// pick the single primary permission-holder for an item:
// the creator's member if they are assigned, else the first assignee, else null.
function pickHolder(members: GoalMember[], createdBy: string | null): GoalMember | null {
  if (members.length === 0) return null;
  if (createdBy) {
    const creator = members.find((m) => m.id === createdBy);
    if (creator) return creator;
  }
  return members[0];
}

let loadBusy = false;
let loadAt = 0;

// ---------- holder avatar: ONE account icon per row, + how many others ----------
// 行が縦に長いツリーなので、顔は代表者1人だけ。ただし他にもアサインされて
// いる事実は +N で見えるようにする (以前は完全に隠れていた)。
function HolderAvatar({ holder, others = 0 }: { holder: GoalMember | null; others?: number }) {
  // 担当が付いていない行は空けておく。「未」を出すと、全行に丸が並んで
  // 誰が持っているかの方が読み取りにくくなる。
  if (!holder) return <span className="inline-block flex-shrink-0" style={{ width: 28, height: 28 }} aria-hidden />;
  return (
    <span className="inline-flex items-center gap-1 flex-shrink-0">
      <Avatar member={holder} size={28} />
      {others > 0 && (
        <span className="text-[11px] font-bold text-[var(--muted)]" title={`ほか${others}人`}>+{others}</span>
      )}
    </span>
  );
}

// ---------- per-row hover action group: + (add child), … (archive), → (open) ----------
function RowActions({
  onAddChild,
  onArchive,
  onOpen,
  onOutdent,
  onIndent,
}: {
  onAddChild: () => void;
  onArchive: () => void;
  onOpen: () => void;
  onOutdent?: () => void; // move up one level (promote); undefined = not possible
  onIndent?: () => void; // move under the previous sibling (demote); undefined = not possible
}) {
  const [menu, setMenu] = useState(false);
  const btn =
    "inline-flex items-center justify-center w-6 h-6 rounded-md text-[var(--muted-soft)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors";
  return (
    <div className="relative flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover/row:opacity-100 transition-opacity">
      {/* add child */}
      <button
        type="button"
        title="サブを追加"
        aria-label="サブを追加"
        onClick={(e) => {
          e.stopPropagation();
          onAddChild();
        }}
        className={btn}
      >
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none">
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {/* menu (…) → archive */}
      <button
        type="button"
        title="メニュー"
        aria-label="メニュー"
        onClick={(e) => {
          e.stopPropagation();
          setMenu((v) => !v);
        }}
        className={btn}
      >
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>

      {/* open (→) */}
      <button
        type="button"
        title="開く"
        aria-label="開く"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className={btn}
      >
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none">
          <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {menu && (
        <>
          {/* click-away backdrop */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(false);
            }}
          />
          <div
            className="absolute right-0 top-7 z-20 min-w-[150px] py-1 rounded-lg bg-white text-left"
            style={{ border: "1px solid var(--border)", boxShadow: "var(--shadow-card)" }}
          >
            {onOutdent && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(false);
                  onOutdent();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--foreground)] hover:bg-[var(--hover)]"
              >
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M11 12H6V4M6 4L3 7M6 4l3 3" /></svg>
                上の階層へ
              </button>
            )}
            {onIndent && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(false);
                  onIndent();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--foreground)] hover:bg-[var(--hover)]"
              >
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h5v8M10 12l3-3M10 12l-3-3" /></svg>
                下の階層へ
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenu(false);
                onArchive();
              }}
              className="block w-full px-3 py-1.5 text-left text-[13px] text-[#d33b3b] hover:bg-[var(--hover)]"
            >
              削除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ItemRow({
  node,
  depth,
  index,
  indent,
  members,
  stats,
  doneShown,
  onToggleDoneChildren,
  collapsed,
  canEdit,
  operableIds,
  parentId,
  outdentTargetId,
  indentTargetId,
  dragId,
  dropHint,
  onToggleCollapse,
  onOpen,
  onAddChild,
  onArchive,
  onToggleDone,
  onStart,
  onMove,
  onDragStartRow,
  onDragEndRow,
  onDragOverRow,
  onDropRow,
}: {
  node: ItemNode;
  depth: number;
  index: number; // 1-based, only meaningful at depth 0
  indent: number; // px per depth level (responsive)
  members: Record<string, GoalMember[]>;
  stats: Map<string, ChildStats>; // 子タスクの 完了/全体。完了を隠していても件数は出す
  doneShown: Set<string>; // この行の完了した子を今出しているか
  onToggleDoneChildren: (id: string) => void;
  collapsed: Set<string>;
  canEdit: boolean; // can mutate the tree (admin / scoped editor); read-only members hide actions
  operableIds: Set<string> | null; // null = full view; otherwise only these ids are interactive (rest = read-only context)
  parentId: string | null; // this node's parent id (null at the top level) — used to wire its children's "outdent" target
  outdentTargetId?: string | null; // where this node goes when promoted (null = top level); undefined = cannot promote
  indentTargetId?: string | null; // previous-sibling id this node nests under when demoted; undefined/null = cannot
  dragId: string | null; // id of the row currently being dragged
  dropHint: DropHint; // active drop indicator (row id + position)
  onToggleCollapse: (id: string) => void;
  onOpen: (id: string) => void;
  onAddChild: (id: string) => void;
  onArchive: (id: string) => void;
  onToggleDone: (id: string, done: boolean) => void;
  onStart: (id: string, started: boolean) => void;
  onMove: (id: string, newParentId: string | null, beforeId?: string | null) => void;
  onDragStartRow: (id: string) => void;
  onDragEndRow: () => void;
  onDragOverRow: (id: string, pos: DropPos) => void;
  onDropRow: () => void;
}) {
  const done = node.status === "done";
  const mine = members[node.id] ?? [];
  const stat = stats.get(node.id);
  const isRoot = depth === 0;
  const hasChildren = node.children.length > 0;
  // 未完了の子を持つ = 親。進行中は一番下の小タスクにだけ付けるので、親には開始も印も出さない
  const isParentRow = node.children.some((c) => c.status === "active");
  const isCollapsed = collapsed.has(node.id);
  // context row: shown only to convey where an assigned item connects (ancestor
  // chain). Read-only — no checkbox, no open, no actions; just a muted label.
  const isContext = operableIds != null && !operableIds.has(node.id);
  // move affordances — only for editable, operable rows
  const editable = canEdit && !isContext;
  const canOutdent = editable && outdentTargetId !== undefined;
  const canIndent = editable && indentTargetId != null;
  // drag-and-drop state for this row
  const dragging = dragId === node.id;
  const hint = dropHint && dropHint.id === node.id ? dropHint.pos : null;

  return (
    <>
      <div
        className={`group/row relative flex items-center gap-2 md:gap-2.5 py-2 lg:py-1.5${done ? " done-row" : ""}`}
        style={{
          paddingLeft: depth * indent,
          opacity: dragging ? 0.4 : 1,
          background: hint === "inside" ? "var(--accent-soft)" : undefined,
          borderRadius: hint === "inside" ? 8 : done ? 8 : undefined,
        }}
        draggable={editable}
        onDragStart={(e) => {
          if (!editable) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.id);
          onDragStartRow(node.id);
        }}
        onDragEnd={() => onDragEndRow()}
        onDragOver={(e) => {
          if (!editable || dragId == null || dragId === node.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const y = e.clientY - r.top;
          // reorder is the default (top 40% = before, bottom 40% = after); only a
          // deliberate hit on the narrow center band nests as a child. Keeps
          // sibling reordering — incl. top-level goals — from accidentally nesting.
          const pos: DropPos = y < r.height * 0.4 ? "before" : y > r.height * 0.6 ? "after" : "inside";
          onDragOverRow(node.id, pos);
        }}
        onDrop={(e) => {
          if (dragId == null) return;
          e.preventDefault();
          onDropRow();
        }}
      >
        {/* drag-drop placement indicators */}
        {hint === "before" && <span aria-hidden className="absolute left-0 right-0 top-0 h-[3px] rounded-full" style={{ background: "var(--accent)" }} />}
        {hint === "after" && <span aria-hidden className="absolute left-0 right-0 bottom-0 h-[3px] rounded-full" style={{ background: "var(--accent)" }} />}
        {/* L-shaped tree connector for children */}
        {!isRoot && (
          <span aria-hidden className="absolute left-0 top-0 bottom-0 pointer-events-none" style={{ left: (depth - 1) * indent + 14 }}>
            {/* vertical drop from parent */}
            <span className="absolute top-0 bottom-1/2 w-px" style={{ background: LINE }} />
            {/* horizontal elbow into child */}
            <span className="absolute top-1/2 h-px" style={{ width: indent - 4, background: LINE }} />
          </span>
        )}

        {/* collapse/expand toggle (only when the node has children) */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(node.id);
            }}
            className="flex-shrink-0 w-4 h-4 -ml-1 flex items-center justify-center text-[var(--muted-soft)] hover:text-[var(--foreground)]"
            aria-label={isCollapsed ? "展開" : "折りたたむ"}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? "展開" : "折りたたむ"}
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3 transition-transform" style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }} fill="currentColor">
              <path d="M6 3l5 5-5 5V3z" />
            </svg>
          </button>
        ) : (
          <span className="flex-shrink-0 w-4 h-4 -ml-1" aria-hidden />
        )}

        {/* lead marker: numbered navy circle (root) or blue play button (child) */}
        {isRoot ? (
          <span
            aria-hidden
            className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[13px] font-bold text-white flex-shrink-0"
            style={{ background: isContext ? "var(--muted-soft)" : NAVY }}
          >
            {index}
          </span>
        ) : isContext ? (
          // read-only context node: static muted marker, not openable
          <span
            aria-hidden
            title="つながり（読み取り）"
            className="inline-flex items-center justify-center rounded-full flex-shrink-0"
            style={{ width: 34, height: 34, border: "1px dashed var(--border-strong)" }}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: "var(--muted-soft)" }} />
          </span>
        ) : (
          <button
            type="button"
            title="開く"
            aria-label="開く"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(node.id);
            }}
            className="inline-flex items-center justify-center rounded-full flex-shrink-0 transition-transform hover:scale-105"
            style={{ width: 34, height: 34, background: "var(--accent)" }}
          >
            <svg viewBox="0 0 16 16" className="w-3 h-3 ml-0.5" fill="#fff">
              <path d="M4 3l8 5-8 5V3z" />
            </svg>
          </button>
        )}

        {/* done toggle: round checkbox (empty / filled accent with white check) — hidden on read-only context rows */}
        {!isContext && (
          <TaskCheck t={node} onToggle={(d) => onToggleDone(node.id, d)} onStop={() => onStart(node.id, false)} square idleBorder="var(--border)" parent={isParentRow} />
        )}

        {/* name: drill in (operable) or muted read-only label (context) */}
        {isContext ? (
          <span
            className="min-w-0 truncate text-left text-[14px] cjk text-[var(--muted)]"
            title="つながり（読み取り）"
          >
            {node.emoji && <span className="mr-1.5">{node.emoji}</span>}
            {node.name || "（無題）"}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(node.id)}
            className={`min-w-0 truncate text-left text-[14px] cjk hover:underline ${
              done ? "done-label" : "text-[var(--foreground)]"
            } ${isRoot ? "font-semibold" : ""}`}
          >
            {node.emoji && <span className="mr-1.5">{node.emoji}</span>}
            {node.name || "（無題）"}
          </button>
        )}

        {done && (
          <span
            aria-hidden
            className="inline-flex items-center justify-center w-4 h-4 rounded-full flex-shrink-0"
            style={{ background: "var(--done)" }}
          >
            <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none">
              <path d="M3.5 8.5l3 3 6-6.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}

        {!isContext && <InProgressBadge t={node} wrapClass="hidden sm:inline-flex" parent={isParentRow} />}

        {/* 「完了 3/8」。この下の何件が終わったのかを開かずに出し、
            完了が1件でもあれば、この行だけ出す/隠すを切り替えられるようにする */}
        {stat && stat.total > 0 && (
          stat.done > 0 ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleDoneChildren(node.id); }}
              className={`done-badge shrink-0 ${stat.done === stat.total ? "is-all" : ""}`}
              aria-pressed={doneShown.has(node.id)}
              title={`${stat.total} 件中 ${stat.done} 件が完了。押すとこのタスクの完了を${doneShown.has(node.id) ? "隠す" : "表示する"}`}
            >
              完了 {stat.done}/{stat.total}
              <span className="font-normal opacity-80">・{doneShown.has(node.id) ? "隠す" : "表示"}</span>
            </button>
          ) : (
            <span className="done-badge is-none shrink-0" title={`${stat.total} 件中 0 件が完了`}>
              完了 0/{stat.total}
            </span>
          )
        )}

        {/* push the holder + actions to the right */}
        <div className="ml-auto flex items-center gap-1 md:gap-2 flex-none">
          {/* single holder indicator (primary permission-holder) — left of the actions */}
          {canEdit && !isContext && (
            <StartButton t={node} parent={isParentRow} onToggle={(on) => onStart(node.id, on)} wrapClass="hidden lg:inline-flex lg:opacity-0 lg:group-hover/row:opacity-100" />
          )}
          <HolderAvatar holder={pickHolder(mine, node.created_by)} others={Math.max(0, mine.length - 1)} />
          {canEdit && !isContext && (
            <RowActions
              onAddChild={() => onAddChild(node.id)}
              onArchive={() => onArchive(node.id)}
              onOpen={() => onOpen(node.id)}
              onOutdent={canOutdent ? () => onMove(node.id, outdentTargetId ?? null) : undefined}
              onIndent={canIndent ? () => onMove(node.id, indentTargetId!) : undefined}
            />
          )}
        </div>
      </div>

      {!isCollapsed && node.children.map((c, ci) => (
        <ItemRow
          key={c.id}
          node={c}
          depth={depth + 1}
          index={0}
          indent={indent}
          members={members}
          stats={stats}
          doneShown={doneShown}
          onToggleDoneChildren={onToggleDoneChildren}
          collapsed={collapsed}
          canEdit={canEdit}
          operableIds={operableIds}
          parentId={node.id}
          outdentTargetId={parentId}
          indentTargetId={ci > 0 ? node.children[ci - 1].id : undefined}
          dragId={dragId}
          dropHint={dropHint}
          onToggleCollapse={onToggleCollapse}
          onOpen={onOpen}
          onAddChild={onAddChild}
          onArchive={onArchive}
          onToggleDone={onToggleDone}
          onStart={onStart}
          onMove={onMove}
          onDragStartRow={onDragStartRow}
          onDragEndRow={onDragEndRow}
          onDragOverRow={onDragOverRow}
          onDropRow={onDropRow}
        />
      ))}
    </>
  );
}

// ---------- member personal worklist (no tree, no create) ----------
type TaskGroup = { goalId: string | null; name: string; emoji: string | null; tasks: MyTask[] };

function groupByParent(tasks: MyTask[]): TaskGroup[] {
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

function MemberTasks({ router }: { router: ReturnType<typeof useRouter> }) {
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
              <span className="truncate min-w-0">{g.name}</span>
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
                      className="flex-1 min-w-0 text-left text-[14.5px] truncate cjk hover:underline text-[var(--foreground)]"
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
                          className="flex-1 min-w-0 text-left text-[14.5px] truncate cjk hover:underline line-through text-[var(--muted-soft)]"
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

export default function TasksPage() {
  const router = useRouter();
  const indent = useIndent();
  const [admin, setAdmin] = useState<boolean | null>(null);
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
  const seededCollapse = useRef(false);
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
  const applyView = (visible: Goal[], operable: Set<string> | null) => {
    setItems(visible);
    setOperableIds(operable);
    if (!seededCollapse.current && visible.length > 0) {
      const parents = new Set<string>();
      for (const it of visible) {
        const p = it.parent_goal_id;
        if (p && (operable == null || operable.has(p))) parents.add(p);
      }
      setCollapsed(parents);
      seededCollapse.current = true;
    }
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
        const goalsP = listGoals().catch(() => [] as Goal[]);
        const membersP = listGoalMembersAll().catch(() => ({}) as Record<string, GoalMember[]>);
        const me = await getMe().catch(() => ({ user: null, needsBootstrap: false, scopeGoalId: null }));
        const isAdmin = me?.user?.role === "admin";
        const isScoped = !!me?.scopeGoalId;
        if (!alive) return;
        setAdmin(isAdmin); setScoped(isScoped);
        // admins / scoped editors see the full tree (and can mutate it). Plain
        // members see only their assigned items + the ancestor chain showing what
        // those connect to (read-only context); unrelated branches are dropped.
        // admins / scoped: assignees don't depend on the id list, so fetch them in
        // parallel with the tree instead of after it
        const all = await goalsP;
        if (!alive) return;
        let visible = all;
        let operable: Set<string> | null = null;
        if (!isAdmin && !isScoped) {
          const mine = await getMyTasks().catch(() => [] as MyTask[]);
          if (!alive) return;
          const pruned = pruneToAssigned(all, new Set(mine.map((t) => t.id)));
          visible = pruned.visible;
          operable = pruned.operable;
        }
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
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleShowDone}
              className={`chip${showDone ? " chip-done-on" : ""}`}
              aria-pressed={showDone}
              title={showDone ? "すべてのタスクの完了を隠す" : "すべてのタスクの完了をその場に表示する"}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              {showDone ? "完了を全部隠す" : "完了を全部表示"}
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

        {/* PC(lg+): 左=ゴールツリー / 右=期限が近い。スマホは期限が近い→ツリーの縦1列 */}
        <div className="lg:flex lg:gap-8 lg:items-start">
        <div className="lg:hidden">
        {upcomingDeadlines.length > 0 && (
          <div className="card px-4 py-1 mb-6 divide-y divide-[var(--border)]">
            <div className="flex items-center gap-1.5 py-2 text-[13px] font-semibold text-[var(--muted)] cjk">
              期限が近い
              <span className="font-normal text-[var(--muted-soft)]">{upcomingDeadlines.length}</span>
            </div>
            {upcomingDeadlines.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => router.push(`/goals/${g.id}`)}
                onMouseEnter={() => prefetchGoalBundle(g.id)}
                className="flex items-center gap-2 w-full text-left py-2.5 hover:bg-[var(--hover)]"
              >
                {g.emoji && <span className="shrink-0">{g.emoji}</span>}
                <span className="flex-1 min-w-0 truncate text-[14px] cjk text-[var(--foreground)]">{g.name || "（無題）"}</span>
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
                          className="min-w-0 truncate text-left text-[14px] cjk hover:underline done-label"
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
            <div className="flex items-center gap-1.5 py-2 text-[13px] font-semibold text-[var(--muted)] cjk">
              期限が近い
              <span className="font-normal text-[var(--muted-soft)]">{upcomingDeadlines.length}</span>
            </div>
            {upcomingDeadlines.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => router.push(`/goals/${g.id}`)}
                onMouseEnter={() => prefetchGoalBundle(g.id)}
                className="flex items-center gap-2 w-full text-left py-2.5 hover:bg-[var(--hover)]"
              >
                {g.emoji && <span className="shrink-0">{g.emoji}</span>}
                <span className="flex-1 min-w-0 truncate text-[14px] cjk text-[var(--foreground)]">{g.name || "（無題）"}</span>
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
