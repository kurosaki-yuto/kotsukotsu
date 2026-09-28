"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { supabase, type DbNode, type Project, type TreeNode, type Member } from "../lib/db";
import {
  listProjectNodes,
  buildTree,
  insertNodeAfter,
  updateNodeText,
  deleteNode,
  indentNode,
  outdentNode,
  toggleNodeComplete,
  moveNode,
  setNodeDue,
} from "../lib/queries";
import { getMe, listMembers, listNodeMembers, assignNodeMember, unassignNodeMember, type Me, type NodeMemberRow } from "../lib/addness";
import { useAutoRefresh } from "../lib/useAutoRefresh";
import { Assignees, Avatar } from "./Assignees";

type FlatRow = { node: TreeNode; depth: number };

// ISO UTC -> "YYYY-MM-DDTHH:mm" in the browser's local time, for
// <input type="datetime-local">'s value/defaultValue.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatDueBadge(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function flatten(tree: TreeNode[], depth = 0): FlatRow[] {
  const out: FlatRow[] = [];
  for (const n of tree) {
    out.push({ node: n, depth });
    if (n.children.length) out.push(...flatten(n.children, depth + 1));
  }
  return out;
}

type FilterMode = "open" | "all" | "done";
const FILTER_LABEL: Record<FilterMode, string> = {
  open: "未完了のみ",
  all: "全件",
  done: "完了のみ",
};
const FILTER_NEXT: Record<FilterMode, FilterMode> = {
  open: "all",
  all: "done",
  done: "open",
};

export default function Outliner({ project, embedded = false }: { project: Project; embedded?: boolean }) {
  const [rows, setRows] = useState<DbNode[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  // mirror of `texts` for the unmount flush (avoids a stale closure)
  const textsRef = useRef<Record<string, string>>({});
  textsRef.current = texts;
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pendingFocusEnd, setPendingFocusEnd] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<{ id: string; before: boolean } | null>(null);
  const [filter, setFilter] = useState<FilterMode>("open");

  // per-task assignment (who holds each task)
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [nodeAssignees, setNodeAssignees] = useState<Record<string, NodeMemberRow[]>>({});
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [dueFor, setDueFor] = useState<string | null>(null);
  const canAssign = me?.role === "admin" || (!!project.created_by && project.created_by === me?.id);

  const loadAssignees = useCallback(async () => {
    try { setNodeAssignees(await listNodeMembers(project.id)); } catch {}
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { const { user } = await getMe(); if (alive) setMe(user); } catch {}
      try { const ms = (await listMembers()).filter((m) => !m.is_ai); if (alive) setMembers(ms); } catch {}
    })();
    loadAssignees();
    return () => { alive = false; };
  }, [project.id, loadAssignees]);

  const toggleNodeAssign = useCallback(
    async (nodeId: string, memberId: string, assigned: boolean) => {
      try {
        if (assigned) await unassignNodeMember(nodeId, memberId);
        else await assignNodeMember(nodeId, memberId);
        await loadAssignees();
      } catch (e) { console.error(e); }
    },
    [loadAssignees]
  );

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("outliner-filter") : null;
    if (saved === "open" || saved === "all" || saved === "done") setFilter(saved);
  }, []);

  const cycleFilter = useCallback(() => {
    setFilter((cur) => {
      const next = FILTER_NEXT[cur];
      if (typeof window !== "undefined") window.localStorage.setItem("outliner-filter", next);
      return next;
    });
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const flushTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const refreshRequested = useRef(false);
  const editingId = useRef<string | null>(null);
  const opQueue = useRef<Promise<unknown>>(Promise.resolve());

  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = opQueue.current.then(fn, fn);
    opQueue.current = next.catch(() => undefined);
    return next;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await listProjectNodes(project.id);
      setRows((prevRows) => {
        // Preserve any optimistic rows whose DB row hasn't returned yet.
        const dbIds = new Set(list.map((r) => r.id));
        const optimistic = prevRows.filter(
          (r) => !dbIds.has(r.id) && Number.isFinite(r.order_idx) && !Number.isInteger(r.order_idx)
        );
        return [...list, ...optimistic];
      });
      setTexts((prev) => {
        const next = { ...prev };
        const seen = new Set<string>();
        for (const r of list) {
          seen.add(r.id);
          if (next[r.id] === undefined) next[r.id] = r.text;
        }
        // Keep optimistic ids' texts; drop everything else not seen.
        for (const k of Object.keys(next)) {
          if (!seen.has(k) && next[k] === undefined) delete next[k];
        }
        return next;
      });
    } catch (e) {
      console.error("[outliner] refresh failed", e);
    }
  }, [project.id]);

  // refetch nodes on focus + interval so other devices / AI (MCP) changes show
  // up; skip while a node input is focused to avoid disrupting active editing.
  useAutoRefresh(() => { if (!editingId.current) void refresh(); });

  useEffect(() => {
    refresh();
    const ch = supabase()
      .channel(`nodes-${project.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "nodes", filter: `project_id=eq.${project.id}` },
        () => {
          if (refreshRequested.current) return;
          refreshRequested.current = true;
          setTimeout(() => {
            refreshRequested.current = false;
            refresh();
          }, 80);
        }
      )
      .subscribe();
    return () => {
      supabase().removeChannel(ch);
    };
  }, [project.id, refresh]);

  const flatAll = useMemo(() => flatten(buildTree(rows)), [rows]);
  const flat = useMemo(() => {
    if (filter === "all") return flatAll;
    if (filter === "open") return flatAll.filter((r) => r.node.completed_at == null);
    return flatAll.filter((r) => r.node.completed_at != null);
  }, [flatAll, filter]);
  const doneCount = useMemo(() => flatAll.filter((r) => r.node.completed_at != null).length, [flatAll]);

  // Focus restore
  useEffect(() => {
    if (!focusId) return;
    const el = containerRef.current?.querySelector<HTMLInputElement>(
      `[data-id="${focusId}"] input.text-input`
    );
    if (!el) return;
    el.focus();
    if (pendingFocusEnd) {
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
      setPendingFocusEnd(false);
    }
  }, [focusId, flat.length, pendingFocusEnd]);

  const flushText = useCallback(
    (id: string, text: string) => {
      // Serialize through the SAME queue as insertNodeAfter so a text save can
      // never race ahead of the row's insert (which would no-op against a
      // not-yet-created node and lose the typed text on reload).
      enqueue(() => updateNodeText(id, text)).catch((e) => console.error("[outliner] save failed", e));
    },
    [enqueue]
  );

  // On unmount (e.g. navigating away), persist any still-pending debounced edits
  // so typed text is never dropped.
  useEffect(() => {
    const timers = flushTimers.current;
    return () => {
      for (const id of Object.keys(timers)) {
        clearTimeout(timers[id]);
        const t = textsRef.current[id];
        if (t !== undefined) updateNodeText(id, t).catch(() => {});
      }
    };
  }, []);

  const scheduleFlush = useCallback(
    (id: string, text: string) => {
      if (flushTimers.current[id]) clearTimeout(flushTimers.current[id]);
      flushTimers.current[id] = setTimeout(() => flushText(id, text), 250);
    },
    [flushText]
  );

  const flushNow = (id: string) => {
    if (flushTimers.current[id]) {
      clearTimeout(flushTimers.current[id]);
      delete flushTimers.current[id];
    }
    const t = texts[id];
    if (t === undefined) return;
    const dbRow = rows.find((r) => r.id === id);
    if (dbRow && dbRow.text === t) return;
    flushText(id, t);
  };

  const handleChange = (id: string, value: string) => {
    setTexts((prev) => ({ ...prev, [id]: value }));
    scheduleFlush(id, value);
  };

  const handleKeyDown = async (
    id: string,
    e: React.KeyboardEvent<HTMLInputElement>
  ) => {
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key;
    // IME composition guard — keep IME confirm Enter from triggering row ops
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (key === "Enter" && !e.shiftKey && !meta) {
      e.preventDefault();
      flushNow(id);
      const me = rows.find((r) => r.id === id);
      if (!me) return;
      const newId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const optimistic: DbNode = {
        id: newId,
        project_id: project.id,
        parent_id: me.parent_id,
        text: "",
        order_idx: me.order_idx + 0.5,
        created_at: nowIso,
        updated_at: nowIso,
        completed_at: null,
        today_date: null,
        estimate_min: null,
        due_at: null,
        reminded_at: null,
      };
      // Synchronous insert + render so the next typed keys land in the new row.
      flushSync(() => {
        setRows((prev) => [...prev, optimistic]);
        setTexts((prev) => ({ ...prev, [newId]: "" }));
      });
      const el = containerRef.current?.querySelector<HTMLInputElement>(
        `[data-id="${newId}"] input.text-input`
      );
      el?.focus();
      // Persist asynchronously, serialized
      enqueue(() =>
        insertNodeAfter({
          id: newId,
          projectId: project.id,
          parentId: me.parent_id,
          afterId: id,
        })
      )
        .catch((err) => console.error("[outliner] insert failed", err))
        .finally(() => refresh());
      return;
    }

    if (key === "Enter" && meta) {
      e.preventDefault();
      flushNow(id);
      await checkRow(id);
      return;
    }

    if (key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      flushNow(id);
      enqueue(() => indentNode(id))
        .catch((err) => console.error("[outliner] indent failed", err))
        .finally(() => refresh());
      setFocusId(id);
      setPendingFocusEnd(true);
      return;
    }

    if (key === "Tab" && e.shiftKey) {
      e.preventDefault();
      flushNow(id);
      enqueue(() => outdentNode(id))
        .catch((err) => console.error("[outliner] outdent failed", err))
        .finally(() => refresh());
      setFocusId(id);
      setPendingFocusEnd(true);
      return;
    }

    if (key === "Backspace") {
      const cur = texts[id] ?? "";
      if (cur === "") {
        e.preventDefault();
        const idx = flat.findIndex((r) => r.node.id === id);
        const prevId = flat[idx - 1]?.node.id ?? null;
        flushSync(() => {
          setRows((prev) => prev.filter((r) => r.id !== id));
          setTexts((prev) => {
            const n = { ...prev };
            delete n[id];
            return n;
          });
        });
        if (prevId) {
          setFocusId(prevId);
          setPendingFocusEnd(true);
        }
        enqueue(() => deleteNode(id))
          .catch((err) => console.error("[outliner] delete failed", err))
          .finally(() => refresh());
      }
      return;
    }

    if (key === "ArrowUp") {
      const idx = flat.findIndex((r) => r.node.id === id);
      const prevId = flat[idx - 1]?.node.id;
      if (prevId) {
        e.preventDefault();
        setFocusId(prevId);
        setPendingFocusEnd(true);
      }
      return;
    }

    if (key === "ArrowDown") {
      const idx = flat.findIndex((r) => r.node.id === id);
      const nextId = flat[idx + 1]?.node.id;
      if (nextId) {
        e.preventDefault();
        setFocusId(nextId);
        setPendingFocusEnd(true);
      }
      return;
    }
  };

  const checkRow = async (id: string) => {
    flushNow(id);
    const current = rows.find((r) => r.id === id);
    if (!current) return;
    const nextCompleted = current.completed_at == null;
    const nowIso = new Date().toISOString();
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, completed_at: nextCompleted ? nowIso : null } : r
      )
    );
    enqueue(() => toggleNodeComplete(id, nextCompleted))
      .catch((err) => console.error("[outliner] toggle complete failed", err))
      .finally(() => refresh());
  };

  // datetime-local value ("YYYY-MM-DDTHH:mm", parsed as browser-local time) ->
  // ISO UTC string for storage; empty/null clears the due date.
  const applyDue = useCallback(
    (id: string, localValue: string) => {
      const dueAt = localValue ? new Date(localValue).toISOString() : null;
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, due_at: dueAt, reminded_at: null } : r)));
      setDueFor(null);
      enqueue(() => setNodeDue(id, dueAt))
        .catch((err) => console.error("[outliner] set due failed", err))
        .finally(() => refresh());
    },
    [enqueue, refresh]
  );

  const removeRow = useCallback(
    (id: string) => {
      flushSync(() => {
        setRows((prev) => prev.filter((r) => r.id !== id));
        setTexts((prev) => {
          const n = { ...prev };
          delete n[id];
          return n;
        });
      });
      enqueue(() => deleteNode(id))
        .catch((err) => console.error("[outliner] delete failed", err))
        .finally(() => refresh());
    },
    [enqueue, refresh]
  );

  const handleDrop = useCallback(
    (targetId: string, before: boolean) => {
      if (!draggingId || draggingId === targetId) {
        setDraggingId(null);
        setDropPos(null);
        return;
      }
      const target = rows.find((r) => r.id === targetId);
      if (!target) {
        setDraggingId(null);
        setDropPos(null);
        return;
      }
      const newParentId = target.parent_id;
      const siblings = rows
        .filter((r) => r.parent_id === newParentId && r.id !== draggingId)
        .sort((a, b) => a.order_idx - b.order_idx);
      const tIdx = siblings.findIndex((s) => s.id === targetId);
      const newIndex = tIdx + (before ? 0 : 1);
      const movedId = draggingId;
      setDraggingId(null);
      setDropPos(null);
      // Optimistic local move
      flushSync(() => {
        setRows((prev) => {
          const newPosition = newParentId;
          // Adjust client-side order_idx to land between neighbours.
          const dest = prev
            .filter((r) => r.parent_id === newPosition && r.id !== movedId)
            .sort((a, b) => a.order_idx - b.order_idx);
          const clamped = Math.max(0, Math.min(newIndex, dest.length));
          const before2 = dest[clamped - 1]?.order_idx;
          const after2 = dest[clamped]?.order_idx;
          let newOrder: number;
          if (before2 == null && after2 == null) newOrder = 0;
          else if (before2 == null) newOrder = (after2 as number) - 1;
          else if (after2 == null) newOrder = (before2 as number) + 1;
          else newOrder = ((before2 as number) + (after2 as number)) / 2;
          return prev.map((r) =>
            r.id === movedId ? { ...r, parent_id: newParentId, order_idx: newOrder } : r
          );
        });
      });
      enqueue(() => moveNode({ id: movedId, newParentId, newIndex }))
        .catch((err) => console.error("[outliner] move failed", err))
        .finally(() => refresh());
    },
    [draggingId, rows, enqueue, refresh]
  );

  const addFirstRow = useCallback(() => {
    const newId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const optimistic: DbNode = {
      id: newId,
      project_id: project.id,
      parent_id: null,
      text: "",
      order_idx: 0.5,
      created_at: nowIso,
      updated_at: nowIso,
      completed_at: null,
      today_date: null,
      estimate_min: null,
      due_at: null,
      reminded_at: null,
    };
    flushSync(() => {
      setRows((prev) => [...prev, optimistic]);
      setTexts((p) => ({ ...p, [newId]: "" }));
    });
    const el = containerRef.current?.querySelector<HTMLInputElement>(
      `[data-id="${newId}"] input.text-input`
    );
    el?.focus();
    enqueue(() =>
      insertNodeAfter({
        id: newId,
        projectId: project.id,
        parentId: null,
        afterId: null,
      })
    )
      .catch((err) => console.error("[outliner] insert failed", err))
      .finally(() => refresh());
  }, [project.id, refresh, enqueue]);

  return (
    <div className={embedded ? "" : "flex-1 min-w-0 overflow-y-auto"} style={embedded ? undefined : { background: "var(--background)" }}>
      <div className={embedded ? "" : "max-w-3xl mx-auto px-8 sm:px-12 pt-12 pb-32"}>
        {!embedded && (
        <div className="flex items-baseline gap-3 mb-6">
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: "var(--foreground)" }}>
            {project.name}
          </h1>
          <span className="text-xs tabular-nums" style={{ color: "var(--muted-soft)" }}>
            {flat.length} / {flatAll.length} 件
            {doneCount > 0 && filter !== "done" && ` (完了 ${doneCount})`}
          </span>
          <button
            type="button"
            onClick={cycleFilter}
            className="ml-auto text-xs px-2 py-1 rounded-md border"
            style={{
              borderColor: "var(--border)",
              color: "var(--muted)",
              background: "var(--surface)",
            }}
            aria-label="表示フィルタ切替"
            title="クリックで切替"
          >
            {FILTER_LABEL[filter]}
          </button>
        </div>
        )}

        <div ref={containerRef}>
          {flat.length === 0 ? (
            <button
              onClick={addFirstRow}
              className="text-[var(--muted-soft)] hover:text-[var(--foreground)] cursor-text py-3.5 px-1 text-left w-full text-[17px] flex items-center gap-2 rounded-lg hover:bg-[var(--hover)]"
            >
              <span className="text-xl leading-none">＋</span>{embedded ? "タスクを入力（〜する の形で）" : "クリックして最初のタスクを追加…"}
            </button>
          ) : (
            flat.map(({ node, depth }) => {
              const isDone = node.completed_at != null;
              const isDragging = draggingId === node.id;
              const showLineBefore = dropPos?.id === node.id && dropPos.before;
              const showLineAfter = dropPos?.id === node.id && !dropPos.before;
              return (
                <div key={node.id} className="relative" style={{ paddingLeft: depth * 26 }}>
                  {showLineBefore && (
                    <div
                      className="absolute left-0 right-0 h-0.5 -top-px rounded-full pointer-events-none"
                      style={{ background: "var(--accent)", marginLeft: depth * 26 }}
                    />
                  )}
                  <div
                    className={`row${isDone ? " done" : ""}`}
                    data-id={node.id}
                    style={{ opacity: isDragging ? 0.4 : 1 }}
                    onDragOver={(e) => {
                      if (!draggingId || draggingId === node.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                      const before = e.clientY < rect.top + rect.height / 2;
                      if (dropPos?.id !== node.id || dropPos.before !== before) {
                        setDropPos({ id: node.id, before });
                      }
                    }}
                    onDragLeave={(e) => {
                      const related = e.relatedTarget as Node | null;
                      if (!(e.currentTarget as HTMLElement).contains(related)) {
                        setDropPos((cur) => (cur?.id === node.id ? null : cur));
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const before = dropPos?.id === node.id ? dropPos.before : true;
                      handleDrop(node.id, before);
                    }}
                  >
                    <button
                      type="button"
                      className="drag-handle"
                      aria-label="並べ替え"
                      draggable
                      onDragStart={(e) => {
                        setDraggingId(node.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", node.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDropPos(null);
                      }}
                    >
                      ⋮⋮
                    </button>
                    <button
                      type="button"
                      className="check"
                      aria-label="完了"
                      aria-pressed={isDone}
                      onClick={() => checkRow(node.id)}
                    >
                      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                          d="M3.5 8.5l3 3 6-7"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <input
                      className="text-input"
                      type="text"
                      value={texts[node.id] ?? node.text}
                      placeholder="タスクを入力…"
                      onChange={(e) => handleChange(node.id, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(node.id, e)}
                      onFocus={() => {
                        editingId.current = node.id;
                      }}
                      onBlur={() => {
                        flushNow(node.id);
                        if (editingId.current === node.id) editingId.current = null;
                      }}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <div className="node-assignees" onMouseDown={(e) => e.preventDefault()}>
                      <Assignees members={nodeAssignees[node.id] ?? []} size={20} max={3} />
                      {canAssign && (
                        <div className="relative">
                          <button
                            type="button"
                            className="node-assign-btn"
                            aria-label="担当をアサイン"
                            title="担当をアサイン"
                            onClick={() => setAssignFor(assignFor === node.id ? null : node.id)}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M19 8v6M22 11h-6" /></svg>
                          </button>
                          {assignFor === node.id && (
                            <div className="absolute right-0 top-7 z-30 card w-56 max-h-72 overflow-y-auto py-1" style={{ boxShadow: "var(--shadow-pop)" }} onMouseLeave={() => setAssignFor(null)}>
                              <div className="px-3 py-1.5 text-[11px] font-bold text-[var(--muted)]">担当者をアサイン</div>
                              {members.length === 0 ? (
                                <div className="px-3 py-3 text-[12px] text-[var(--muted-soft)]">メンバーがいません</div>
                              ) : (
                                members.map((m) => {
                                  const assigned = (nodeAssignees[node.id] ?? []).some((a) => a.id === m.id);
                                  return (
                                    <button key={m.id} type="button" onClick={() => toggleNodeAssign(node.id, m.id, assigned)} className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--hover)]">
                                      <Avatar member={m} size={20} />
                                      <span className="flex-1 truncate">{m.name}</span>
                                      {assigned && <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="relative" onMouseDown={(e) => e.preventDefault()}>
                      <button
                        type="button"
                        className="shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md"
                        style={{ color: node.due_at ? "var(--danger, #e5484d)" : "var(--muted-soft)" }}
                        aria-label="期限を設定"
                        title={node.due_at ? `期限: ${formatDueBadge(node.due_at)}` : "期限を設定"}
                        onClick={() => setDueFor(dueFor === node.id ? null : node.id)}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
                        {node.due_at && formatDueBadge(node.due_at)}
                      </button>
                      {dueFor === node.id && (
                        <div className="absolute right-0 top-7 z-30 card p-3 w-64 flex flex-col gap-2" style={{ boxShadow: "var(--shadow-pop)" }} onMouseLeave={() => setDueFor(null)}>
                          <div className="text-[11px] font-bold text-[var(--muted)]">期限日時(過ぎたらリマインド通知)</div>
                          <input
                            type="datetime-local"
                            defaultValue={isoToLocalInput(node.due_at)}
                            className="w-full bg-[var(--hover)] rounded-lg px-2 py-1.5 text-[13px] focus:outline-none"
                            onKeyDown={(e) => { if (e.key === "Enter") applyDue(node.id, (e.target as HTMLInputElement).value); }}
                            id={`due-input-${node.id}`}
                          />
                          <div className="flex gap-2 justify-end">
                            {node.due_at && (
                              <button type="button" onClick={() => applyDue(node.id, "")} className="text-[12px] text-[var(--muted)] hover:text-[var(--danger)] px-2 py-1">クリア</button>
                            )}
                            <button
                              type="button"
                              onClick={() => applyDue(node.id, (document.getElementById(`due-input-${node.id}`) as HTMLInputElement)?.value ?? "")}
                              className="text-[12px] text-white px-3 py-1 rounded-md"
                              style={{ background: "var(--accent)" }}
                            >
                              設定
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="row-del"
                      aria-label="削除"
                      title="タスクを削除"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => removeRow(node.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                    </button>
                  </div>
                  {showLineAfter && (
                    <div
                      className="absolute left-0 right-0 h-0.5 -bottom-px rounded-full pointer-events-none"
                      style={{ background: "var(--accent)", marginLeft: depth * 26 }}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>

        {flat.length > 0 && (
          <button
            onClick={addFirstRow}
            className="mt-3 text-[var(--muted)] hover:text-[var(--foreground)] py-2.5 text-[15px] flex items-center gap-2"
          >
            <span className="text-lg leading-none">＋</span>{embedded ? "タスクを追加" : "行を追加"}
          </button>
        )}
      </div>

      {!embedded && <MobileBar
        onIndent={async () => {
          const id = editingId.current ?? focusId;
          if (!id) return;
          flushNow(id);
          await indentNode(id);
          setFocusId(id);
          setPendingFocusEnd(true);
          await refresh();
        }}
        onOutdent={async () => {
          const id = editingId.current ?? focusId;
          if (!id) return;
          flushNow(id);
          await outdentNode(id);
          setFocusId(id);
          setPendingFocusEnd(true);
          await refresh();
        }}
        onEnter={async () => {
          const id = editingId.current ?? focusId;
          if (!id) return;
          const me = rows.find((r) => r.id === id);
          if (!me) return;
          flushNow(id);
          const created = await insertNodeAfter({
            projectId: project.id,
            parentId: me.parent_id,
            afterId: id,
          });
          setTexts((p) => ({ ...p, [created.id]: "" }));
          setFocusId(created.id);
          setPendingFocusEnd(true);
          await refresh();
        }}
        onDone={() => {
          const id = editingId.current ?? focusId;
          if (id) checkRow(id);
        }}
      />}
    </div>
  );
}

function MobileBar({
  onIndent,
  onOutdent,
  onEnter,
  onDone,
}: {
  onIndent: () => void;
  onOutdent: () => void;
  onEnter: () => void;
  onDone: () => void;
}) {
  return (
    <div
      className="md:hidden fixed bottom-0 left-0 right-0 flex items-center justify-around p-2 z-20 border-t"
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0) + 8px)",
      }}
    >
      <button onMouseDown={(e) => e.preventDefault()} onClick={onOutdent} className="px-3 py-2 text-base">
        ⇤
      </button>
      <button onMouseDown={(e) => e.preventDefault()} onClick={onIndent} className="px-3 py-2 text-base">
        ⇥
      </button>
      <button onMouseDown={(e) => e.preventDefault()} onClick={onEnter} className="px-3 py-2 text-base">
        + 行
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDone}
        className="px-3 py-2 text-base font-semibold"
        style={{ color: "var(--accent)" }}
      >
        ✓ 完了
      </button>
    </div>
  );
}
