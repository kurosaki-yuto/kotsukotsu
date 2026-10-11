"use client";

// タスク画面の 1 行 (ドラッグ・折りたたみ・開始・完了・サブ追加・削除)。app/page.tsx から切り出し。
import { useState } from "react";
import type { GoalMember } from "../../lib/addness";
import { Avatar } from "../Assignees";
import { InProgressBadge, StartButton, TaskCheck } from "../InProgress";
import { LINE, NAVY, pickHolder, type ItemNode, type DropPos, type DropHint, type ChildStats } from "./tree";

// ---------- holder avatar: ONE account icon per row, + how many others ----------
// 行が縦に長いツリーなので、顔は代表者1人だけ。ただし他にもアサインされて
// いる事実は +N で見えるようにする (以前は完全に隠れていた)。
export function HolderAvatar({ holder, others = 0 }: { holder: GoalMember | null; others?: number }) {
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
export function RowActions({
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

export function ItemRow({
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
        className={`group/row relative flex flex-wrap items-center gap-x-2 gap-y-1 md:gap-x-2.5 py-2 lg:py-1.5${done ? " done-row" : ""}`}
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
            className="min-w-0 basis-[10rem] grow md:grow-0 md:basis-auto break-words text-left text-[14px] cjk text-[var(--muted)]"
            title="つながり（読み取り）"
          >
            {node.emoji && <span className="mr-1.5">{node.emoji}</span>}
            {node.name || "（無題）"}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(node.id)}
            className={`min-w-0 basis-[10rem] grow md:grow-0 md:basis-auto break-words text-left text-[14px] cjk hover:underline ${
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
