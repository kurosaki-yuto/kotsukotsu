"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase, type Project } from "../lib/db";
import { listProjects, createProject, deleteProject, renameProject, reorderProjects } from "../lib/queries";

type Counts = Record<string, number>;

export default function Sidebar({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<{ id: string; before: boolean } | null>(null);

  const refresh = async () => {
    try {
      const ps = await listProjects();
      setProjects(ps);
      const { data } = await supabase().from("nodes").select("project_id");
      const c: Counts = {};
      for (const row of (data ?? []) as { project_id: string }[]) {
        c[row.project_id] = (c[row.project_id] ?? 0) + 1;
      }
      setCounts(c);
      if (!selectedId && ps.length) onSelect(ps[0].id);
    } catch (e) {
      console.error("[sidebar] refresh failed", e);
    }
  };

  useEffect(() => {
    refresh();
    const ch = supabase()
      .channel("sidebar-projects")
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, () => refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "nodes" }, () => refresh())
      .subscribe();
    return () => {
      supabase().removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) {
      setAdding(false);
      return;
    }
    try {
      const proj = await createProject(name);
      setNewName("");
      setAdding(false);
      onSelect(proj.id);
    } catch (e) {
      console.error(e);
      alert("作成失敗");
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`プロジェクト「${name}」を削除する？ (タスクも全部消える)`)) return;
    await deleteProject(id);
    if (selectedId === id) {
      const remaining = projects.filter((p) => p.id !== id);
      if (remaining[0]) onSelect(remaining[0].id);
    }
  };

  const handleRename = async (id: string) => {
    const name = renameVal.trim();
    setRenamingId(null);
    if (!name) return;
    await renameProject(id, name);
  };

  const persistOrder = async (next: Project[]) => {
    setProjects(next); // optimistic
    try {
      await reorderProjects(next.map((p) => p.id));
    } catch (e) {
      console.error("[sidebar] reorder failed", e);
      refresh();
    }
  };

  const handleDrop = async (targetId: string, before: boolean) => {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      setDropPos(null);
      return;
    }
    const fromIdx = projects.findIndex((p) => p.id === draggingId);
    if (fromIdx < 0) return;
    const without = projects.filter((p) => p.id !== draggingId);
    let toIdx = without.findIndex((p) => p.id === targetId);
    if (toIdx < 0) toIdx = without.length;
    if (!before) toIdx += 1;
    const moved = projects[fromIdx];
    const next = [...without.slice(0, toIdx), moved, ...without.slice(toIdx)];
    setDraggingId(null);
    setDropPos(null);
    await persistOrder(next);
  };

  return (
    <aside
      className="w-72 shrink-0 border-r flex flex-col h-full"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div className="px-5 pt-6 pb-3 select-none">
        <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)] font-semibold">
          プロジェクト
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pb-2">
        {projects.map((p) => {
          const active = p.id === selectedId;
          if (renamingId === p.id) {
            return (
              <div key={p.id} className="px-3 py-1">
                <input
                  className="w-full bg-transparent border rounded-md px-3 py-2 text-base focus:outline-none"
                  style={{ borderColor: "var(--border-strong)" }}
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => handleRename(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.currentTarget as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              </div>
            );
          }
          const isDragging = draggingId === p.id;
          const showLineBefore = dropPos?.id === p.id && dropPos.before;
          const showLineAfter = dropPos?.id === p.id && !dropPos.before;
          return (
            <div key={p.id} className="relative">
              {showLineBefore && (
                <div
                  className="absolute left-3 right-3 h-0.5 -top-px rounded-full pointer-events-none"
                  style={{ background: "var(--accent)" }}
                />
              )}
              <div
                className="group cursor-grab active:cursor-grabbing flex items-center justify-between gap-2 px-4 mx-2 my-0.5 py-2.5 rounded-lg text-[15px] font-medium select-none"
                draggable
                onDragStart={(e) => {
                  setDraggingId(p.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", p.id);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDropPos(null);
                }}
                onDragOver={(e) => {
                  if (!draggingId || draggingId === p.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  const before = e.clientY < rect.top + rect.height / 2;
                  if (dropPos?.id !== p.id || dropPos.before !== before) {
                    setDropPos({ id: p.id, before });
                  }
                }}
                onDragLeave={(e) => {
                  const related = e.relatedTarget as Node | null;
                  if (!(e.currentTarget as HTMLElement).contains(related)) {
                    setDropPos((cur) => (cur?.id === p.id ? null : cur));
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const before = dropPos?.id === p.id ? dropPos.before : true;
                  handleDrop(p.id, before);
                }}
                style={{
                  background: active ? "var(--selected)" : "transparent",
                  color: "var(--foreground)",
                  opacity: isDragging ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!active && !isDragging) (e.currentTarget as HTMLDivElement).style.background = "var(--hover)";
                }}
                onMouseLeave={(e) => {
                  if (!active && !isDragging) (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
                onClick={() => onSelect(p.id)}
                onDoubleClick={() => {
                  setRenamingId(p.id);
                  setRenameVal(p.name);
                }}
              >
                <span className="truncate">{p.name}</span>
                <span className="text-xs tabular-nums shrink-0 group-hover:opacity-0 transition-opacity" style={{ color: "var(--muted-soft)" }}>
                  {counts[p.id] ?? 0}
                </span>
                <button
                  className="absolute right-3 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center justify-center text-[var(--muted)] hover:text-red-600 hover:bg-[var(--background)] rounded w-6 h-6 text-base"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(p.id, p.name);
                  }}
                  title="削除"
                >
                  ×
                </button>
              </div>
              {showLineAfter && (
                <div
                  className="absolute left-3 right-3 h-0.5 -bottom-px rounded-full pointer-events-none"
                  style={{ background: "var(--accent)" }}
                />
              )}
            </div>
          );
        })}
        {adding ? (
          <div className="px-3 py-1">
            <input
              className="w-full bg-transparent border rounded-md px-3 py-2 text-base focus:outline-none"
              style={{ borderColor: "var(--border-strong)" }}
              autoFocus
              placeholder="プロジェクト名"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={handleAdd}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.currentTarget as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setNewName("");
                  setAdding(false);
                }
              }}
            />
          </div>
        ) : (
          <button
            className="w-[calc(100%-1rem)] mx-2 my-1 text-left px-4 py-2.5 text-[15px] text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg"
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "var(--hover)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            onClick={() => setAdding(true)}
          >
            + 新規プロジェクト
          </button>
        )}
      </div>
      <div className="border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <Link
          href="/history"
          className="block text-sm py-2 px-3 rounded-md text-[var(--muted)] hover:text-[var(--foreground)]"
          onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = "var(--hover)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = "transparent")}
        >
          完了履歴 →
        </Link>
      </div>
    </aside>
  );
}
