"use client";

import { type DbNode, type Project, type TreeNode, type DoneEntry } from "./db";

// ---------- fetch helper ----------
async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || r.statusText);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && typeof window !== "undefined") window.dispatchEvent(new Event("kotsukotsu:mutated"));
  return r.status === 204 ? null : r.json();
}

// ---------- projects (== goals) ----------

export async function listProjects(): Promise<Project[]> {
  return (await api("/api/goals")) as Project[];
}

export async function createProject(name: string): Promise<Project> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  return (await api("/api/goals", {
    method: "POST",
    body: JSON.stringify({ name: trimmed }),
  })) as Project;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await api(`/api/goals/${id}`, { method: "PATCH", body: JSON.stringify({ name: trimmed }) });
}

export async function deleteProject(id: string): Promise<void> {
  await api(`/api/goals/${id}`, { method: "DELETE" });
}

export async function reorderProjects(orderedIds: string[]): Promise<void> {
  await Promise.all(
    orderedIds.map((id, i) =>
      api(`/api/goals/${id}`, { method: "PATCH", body: JSON.stringify({ order_idx: i }) })
    )
  );
}

// ---------- nodes ----------

export async function listProjectNodes(projectId: string): Promise<DbNode[]> {
  return (await api(`/api/nodes?project=${encodeURIComponent(projectId)}`)) as DbNode[];
}

export function buildTree(rows: DbNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: TreeNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parent_id) {
      const parent = byId.get(r.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => a.order_idx - b.order_idx);
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export async function getTree(projectId: string): Promise<TreeNode[]> {
  const rows = await listProjectNodes(projectId);
  return buildTree(rows);
}

// Insert a new sibling immediately after `afterId` (or at top if null).
export async function insertNodeAfter(opts: {
  id?: string;
  projectId: string;
  parentId: string | null;
  afterId: string | null;
  text?: string;
}): Promise<DbNode> {
  return (await api("/api/nodes", {
    method: "POST",
    body: JSON.stringify({
      op: "insertAfter",
      projectId: opts.projectId,
      parentId: opts.parentId,
      afterId: opts.afterId,
      text: opts.text ?? "",
      id: opts.id,
    }),
  })) as DbNode;
}

export async function updateNodeText(id: string, text: string): Promise<void> {
  await api("/api/nodes", { method: "POST", body: JSON.stringify({ op: "update", id, text }) });
}

export async function deleteNode(id: string): Promise<void> {
  await api("/api/nodes", { method: "POST", body: JSON.stringify({ op: "delete", id }) });
}

// Indent: make `id` a child of its previous sibling.
export async function indentNode(id: string): Promise<DbNode | null> {
  await api("/api/nodes", { method: "POST", body: JSON.stringify({ op: "indent", id }) });
  return null;
}

// Move `id` under `newParentId` (null = top level) at `newIndex`.
export async function moveNode(opts: {
  id: string;
  newParentId: string | null;
  newIndex: number;
}): Promise<void> {
  await api("/api/nodes", {
    method: "POST",
    body: JSON.stringify({ op: "move", id: opts.id, newParentId: opts.newParentId, newIndex: opts.newIndex }),
  });
}

// Outdent: move `id` out to be a sibling of its parent.
export async function outdentNode(id: string): Promise<DbNode | null> {
  await api("/api/nodes", { method: "POST", body: JSON.stringify({ op: "outdent", id }) });
  return null;
}

// ---------- complete toggle ----------

export async function toggleNodeComplete(id: string, completed: boolean): Promise<void> {
  await api("/api/nodes", { method: "POST", body: JSON.stringify({ op: "toggle", id, completed }) });
}

// ---------- due date / reminder ----------

export async function setNodeDue(id: string, dueAt: string | null): Promise<void> {
  await api("/api/nodes", { method: "POST", body: JSON.stringify({ op: "setDue", id, dueAt }) });
}

// ---------- archive (legacy: done_log archival now server-side) ----------

export async function archiveNode(id: string): Promise<void> {
  // done_log archival is handled server-side; from the client this is a delete.
  await deleteNode(id);
}

// ---------- done log ----------
// NOTE: no API endpoint exists for the done_log; returning [] keeps the history
// page compiling until a /api/done endpoint is added.

export async function recentDone(_limit = 30): Promise<DoneEntry[]> {
  return [];
}

export async function listDone(_opts: { limit?: number; sinceDays?: number } = {}): Promise<DoneEntry[]> {
  return [];
}
