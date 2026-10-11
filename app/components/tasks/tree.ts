// タスク画面のツリーを組む純粋な関数と、行の見た目の定数。画面 (app/page.tsx) と行 (ItemRow) で共有する。
import { useEffect, useState } from "react";
import type { Goal } from "../../lib/db";
import type { GoalMember } from "../../lib/addness";

export type ItemNode = Goal & { children: ItemNode[] };
export type DropPos = "before" | "after" | "inside"; // drag-drop placement relative to a row
export type DropHint = { id: string; pos: DropPos } | null;

// days from today to a "YYYY-MM-DD" deadline (negative = overdue)
export function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

export const INDENT = 28; // px per depth level (desktop)
export const INDENT_MOBILE = 16; // px per depth level (narrow screens)
export const NAVY = "#1e2a78"; // dark navy for top-level number circles
export const LINE = "#d7d8db"; // light gray connector lines

// responsive per-depth indent: smaller on phones so deep rows don't overflow
export function useIndent(): number {
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

export type ChildStats = { done: number; total: number };

// 直下の子の「完了 / 全体」を数える。完了を隠している状態でも、親の行を見れば
// この下が何件中何件終わったのかが分かるようにするための集計。
export function countChildren(items: Goal[]): Map<string, ChildStats> {
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
export function buildItemTree(items: Goal[]): ItemNode[] {
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
export function pruneToAssigned(all: Goal[], assignedIds: Set<string>): { visible: Goal[]; operable: Set<string> } {
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
export function pickHolder(members: GoalMember[], createdBy: string | null): GoalMember | null {
  if (members.length === 0) return null;
  if (createdBy) {
    const creator = members.find((m) => m.id === createdBy);
    if (creator) return creator;
  }
  return members[0];
}
