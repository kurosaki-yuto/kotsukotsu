"use client";

import {
  type Goal,
  type DbNode,
  type Member,
  type AppNotification,
  type ChatMessage,
  type Resource,
  type OrgSettings,
} from "./db";

// ---------- fetch helper ----------
// Almost every caller degrades a failed request to an empty list (`.catch(() => [])`)
// so the page still renders. That is how a broken query has repeatedly looked
// identical to "you have nothing" — assignee avatars all vanishing, notifications
// going missing. The request layer now announces every failure, and AppShell turns
// that into a visible banner, so an empty screen is never silently a broken one.
export const FETCH_ERROR_EVENT = "kotsukotsu:fetch-error";
export const FETCH_OK_EVENT = "kotsukotsu:fetch-ok";
function announce(event: string, detail?: unknown) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(event, { detail }));
}
async function api(path: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(path, {
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch (e) {
    // offline / DNS / aborted — still a failure the viewer must see
    announce(FETCH_ERROR_EVENT, { path, message: e instanceof Error ? e.message : "network error" });
    throw e;
  }
  if (!r.ok) {
    const message = ((await r.json().catch(() => ({}))) as { error?: string }).error || r.statusText;
    // 401 is a normal signed-out state, not a malfunction — the login redirect handles it
    if (r.status !== 401) announce(FETCH_ERROR_EVENT, { path, status: r.status, message });
    throw new Error(message);
  }
  announce(FETCH_OK_EVENT, { path });
  // tell other devices (via the realtime bridge) that we changed something
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && typeof window !== "undefined") window.dispatchEvent(new Event("kotsukotsu:mutated"));
  return r.status === 204 ? null : r.json();
}

// ---------- current user / role ----------
export type Me = { id: string; email: string; name: string | null; role: string };

type MeResp = { user: Me | null; needsBootstrap: boolean; scopeGoalId?: string | null };
// Several components ask "who am I" on mount (page, Outliner, header); each was a
// separate ~0.8s round trip fired back to back. Share one in-flight/recent answer.
let meCache: { at: number; p: Promise<MeResp> } | null = null;
export async function getMe(): Promise<MeResp> {
  const now = Date.now();
  if (meCache && now - meCache.at < 5000) return meCache.p;
  const p = api("/api/auth/me") as Promise<MeResp>;
  meCache = { at: now, p };
  p.catch(() => { meCache = null; });
  return p;
}
export function invalidateMe(): void { meCache = null; }

export function isAdmin(me: Me | null): boolean {
  return me?.role === "admin";
}

// ---------- my profile (personal avatar) ----------
export type MyProfile = { id: string; name: string; avatar: string | null };
export async function getMyProfile(): Promise<MyProfile> {
  return (await api("/api/profile")) as MyProfile;
}
export async function updateMyAvatar(avatar: string | null): Promise<void> {
  await api("/api/profile", { method: "PATCH", body: JSON.stringify({ avatar }) });
}

// ---------- password ----------
export async function changeMyPassword(current: string, password: string): Promise<void> {
  await api("/api/auth/password", { method: "POST", body: JSON.stringify({ current, password }) });
}

// ---------- 退会 ----------
export type AccountPlan = {
  purge: { id: string; name: string }[];
  leave: { id: string; name: string }[];
  blocked: { id: string; name: string }[];
};
export async function getAccountPlan(): Promise<AccountPlan> {
  return api("/api/auth/account");
}
export async function deleteMyAccount(password: string): Promise<void> {
  await api("/api/auth/account", { method: "POST", body: JSON.stringify({ password }) });
}

// ---------- date helpers ----------
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- workspaces ----------
export type Workspace = { id: string; name: string; role: string; logo_url: string | null };
export async function listWorkspaces(): Promise<{ workspaces: Workspace[]; activeId: string }> {
  return (await api("/api/workspaces")) as { workspaces: Workspace[]; activeId: string };
}
export async function createWorkspace(name: string): Promise<{ id: string }> {
  return (await api("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) })) as { id: string };
}
export async function switchWorkspace(workspaceId: string): Promise<void> {
  await api("/api/workspaces/switch", { method: "POST", body: JSON.stringify({ workspaceId }) });
}

// ---------- goals (projects) ----------
export async function listGoals(): Promise<Goal[]> {
  return (await api("/api/goals")) as Goal[];
}

export async function getGoal(id: string): Promise<Goal | null> {
  try {
    return (await api(`/api/goals/${id}`)) as Goal;
  } catch {
    return null;
  }
}

export async function createGoal(name: string): Promise<Goal> {
  return (await api("/api/goals", {
    method: "POST",
    body: JSON.stringify({ name }),
  })) as Goal;
}

export async function updateGoal(id: string, patch: Partial<Goal>): Promise<void> {
  await api(`/api/goals/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function archiveGoal(id: string): Promise<void> {
  await api(`/api/goals/${id}`, { method: "DELETE" });
}

// progress: completed / total leaf subtasks
export async function goalProgress(goalId: string): Promise<{ done: number; total: number }> {
  return (await api(`/api/goals/${goalId}/progress`)) as { done: number; total: number };
}

// ---------- today's todo ----------
// type: "goal" が生きているモデル (projects — ツリーに出ているタスク。MCP の
// set_today が書く)、type: "node" が旧アウトライナーの行。
// 列名は揃えてあるので、type を見ない既存の呼び出しはそのまま動く。
export type TodayItem = DbNode & {
  type: "goal" | "node";
  project_name: string | null;
  /** ゴール行のみ。node 行では undefined。 */
  status?: string;
  deadline?: string | null;
};

export async function listToday(date = todayStr()): Promise<TodayItem[]> {
  return (await api(`/api/today?date=${encodeURIComponent(date)}`)) as TodayItem[];
}

/** id はゴール(タスク)でも旧 node でもよい。 */
export async function setToday(id: string, date: string | null): Promise<void> {
  await api("/api/today", { method: "POST", body: JSON.stringify({ id, date }) });
}

export async function clearToday(date = todayStr()): Promise<void> {
  await api(`/api/today?date=${encodeURIComponent(date)}`, { method: "DELETE" });
}

// ---------- members ----------
export async function listMembers(): Promise<Member[]> {
  return (await api("/api/members")) as Member[];
}

export async function rankedMembers(): Promise<Member[]> {
  return (await api("/api/members?ranked=1")) as Member[];
}

// admin-only: who still has undone assigned tasks
export type MemberProgress = { id: string; name: string; avatar: string | null; is_you: boolean; pending: number; done: number; total: number };
export async function getMemberTaskProgress(): Promise<MemberProgress[]> {
  return (await api("/api/members/progress")) as MemberProgress[];
}

export async function inviteMember(name: string, email?: string): Promise<Member> {
  return (await api("/api/members", {
    method: "POST",
    body: JSON.stringify({ name, email }),
  })) as Member;
}

export async function updateMember(id: string, patch: Partial<Member>): Promise<void> {
  await api(`/api/members/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function removeMember(id: string): Promise<void> {
  await api(`/api/members/${id}`, { method: "DELETE" });
}

/** 管理者が発行するパスワード再設定リンク (24時間・1回限り)。本人に LINE などで渡す。 */
export async function createResetLink(id: string): Promise<{ url: string; expires_at: string }> {
  return api(`/api/members/${id}/reset-link`, { method: "POST" });
}

export async function addPoints(delta: number): Promise<void> {
  await api("/api/members", { method: "PATCH", body: JSON.stringify({ addPoints: delta }) });
}

// ---------- notifications ----------
export type NotificationPage = { items: AppNotification[]; hasMore: boolean; offset: number };
export async function listNotifications(filter: "all" | "unread" = "all", offset = 0): Promise<NotificationPage> {
  return (await api(`/api/notifications?filter=${filter}&offset=${offset}`)) as NotificationPage;
}

export async function unreadCount(): Promise<number> {
  try {
    const { count } = (await api("/api/notifications?count=1")) as { count: number };
    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function markRead(id: string): Promise<void> {
  await api(`/api/notifications/${id}`, { method: "PATCH" });
  announce(UNREAD_CHANGED_EVENT);
}

export async function markAllRead(): Promise<void> {
  await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ all: true }) });
  announce(UNREAD_CHANGED_EVENT);
}

// 「見た」= ベルのバッジを落とすだけ。既読にはしないので、一覧の未読マークは残る。
export const UNREAD_CHANGED_EVENT = "kotsukotsu:unread-changed";
export async function markNotificationsSeen(): Promise<void> {
  await api("/api/notifications", { method: "PATCH", body: JSON.stringify({ seen: true }) });
  announce(UNREAD_CHANGED_EVENT);
}

export async function createNotification(n: Partial<AppNotification>): Promise<void> {
  await api("/api/notifications", {
    method: "POST",
    body: JSON.stringify({
      kind: n.kind ?? "info",
      title: n.title,
      body: n.body ?? null,
      goal_id: n.goal_id ?? null,
    }),
  });
}

// ---------- chat ----------
export async function listMessages(goalId: string): Promise<ChatMessage[]> {
  return (await api(`/api/chat?goal=${encodeURIComponent(goalId)}`)) as ChatMessage[];
}

export async function messageCount(goalId: string): Promise<number> {
  try {
    const { count } = (await api(`/api/chat?goal=${encodeURIComponent(goalId)}&count=1`)) as { count: number };
    return count ?? 0;
  } catch {
    return 0;
  }
}

// author is resolved server-side from the session — never send one from here.
export async function sendMessage(goalId: string, body: string, role: "user" | "addy" | "system" = "user"): Promise<ChatMessage> {
  return (await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ goalId, body, role }),
  })) as ChatMessage;
}

export async function editMessage(id: string, body: string): Promise<ChatMessage> {
  return (await api(`/api/chat/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  })) as ChatMessage;
}

export async function deleteMessage(id: string): Promise<void> {
  await api(`/api/chat/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------- resources ----------
export async function listResources(goalId: string): Promise<Resource[]> {
  return (await api(`/api/resources?goal=${encodeURIComponent(goalId)}`)) as Resource[];
}

export async function createResource(goalId: string, name: string, kind = "note", opts?: { content?: string | null; url?: string | null }): Promise<Resource> {
  return (await api("/api/resources", {
    method: "POST",
    body: JSON.stringify({ goalId, name, kind, content: opts?.content ?? null, url: opts?.url ?? null }),
  })) as Resource;
}

export async function updateResource(id: string, patch: Partial<Resource>): Promise<void> {
  await api("/api/resources", { method: "PATCH", body: JSON.stringify({ id, ...patch }) });
}

export async function deleteResource(id: string): Promise<void> {
  await api(`/api/resources/${id}`, { method: "DELETE" });
}

// ---------- org settings ----------
export async function getOrgSettings(): Promise<OrgSettings> {
  return (await api("/api/settings")) as OrgSettings;
}

export async function updateOrgSettings(patch: Partial<OrgSettings>): Promise<void> {
  await api("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

// ---------- streak (consecutive days with a completion) ----------
export async function computeStreak(): Promise<number> {
  const { streak } = (await api("/api/streak")) as { streak: number };
  return streak ?? 0;
}

// ---------- usage / api key (settings) ----------
export type Usage = { aiRequests: number; aiLimit: number; goals: number; tasks: number; doneTasks: number; notifications: number };
export async function getUsage(): Promise<Usage> {
  return (await api("/api/usage")) as Usage;
}
export async function getApiKey(): Promise<string> {
  const { token } = (await api("/api/apikey")) as { token: string };
  return token;
}
export async function regenApiKey(): Promise<string> {
  const { token } = (await api("/api/apikey", { method: "POST" })) as { token: string };
  return token;
}
// per-member key (any role) — the MCP worker confines it to the member's scope
export async function getMyApiKey(): Promise<string> {
  const { token } = (await api("/api/me/mcp-token")) as { token: string };
  return token;
}
export async function regenMyApiKey(): Promise<string> {
  const { token } = (await api("/api/me/mcp-token", { method: "POST" })) as { token: string };
  return token;
}

// ---------- invites ----------
export type Invite = { token: string; email: string | null; role: string; created_at: string; expires_at: string | null };
export async function listInvites(): Promise<Invite[]> {
  return (await api("/api/invites")) as Invite[];
}
export async function createInvite(email?: string, role: "member" | "admin" = "member"): Promise<{ invite: Invite | null; url: string | null }> {
  return (await api("/api/invites", { method: "POST", body: JSON.stringify({ email: email || null, role }) })) as { invite: Invite | null; url: string | null };
}
export async function revokeInvite(token: string): Promise<void> {
  await api(`/api/invites/${token}`, { method: "DELETE" });
}
// (goal-scoped invite helper)
// Invite scoped to one goal: the joiner can only see/touch that goal's subtree.
export async function createGoalInvite(goalId: string): Promise<{ invite: Invite | null; url: string | null }> {
  return (await api("/api/invites", { method: "POST", body: JSON.stringify({ goalId }) })) as { invite: Invite | null; url: string | null };
}
export async function validateInvite(token: string): Promise<{ valid: boolean; email?: string | null; role?: string; reason?: string }> {
  return (await api(`/api/invites/${encodeURIComponent(token)}`)) as { valid: boolean; email?: string | null; role?: string; reason?: string };
}
// Accept an invite while already signed in (joins + switches the session's workspace).
export async function acceptInviteAsUser(token: string): Promise<{ ok: boolean; joined?: boolean; workspaceId?: string }> {
  return (await api(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" })) as { ok: boolean; joined?: boolean; workspaceId?: string };
}

// ---------- goal members (assignment + per-goal edit permission) ----------
export type GoalMember = { id: string; name: string; email: string | null; avatar: string | null; is_you: boolean; can_edit: boolean };
export async function listGoalMembers(goalId: string): Promise<GoalMember[]> {
  return (await api(`/api/goals/${goalId}/members`)) as GoalMember[];
}
export async function listGoalMembersBatch(goalIds: string[]): Promise<Record<string, GoalMember[]>> {
  if (!goalIds.length) return {};
  return (await api(`/api/goal-members/batch`, { method: "POST", body: JSON.stringify({ ids: goalIds }) })) as Record<string, GoalMember[]>;
}
export async function listGoalMembersAll(): Promise<Record<string, GoalMember[]>> {
  return (await api(`/api/goal-members/batch?all=1`)) as Record<string, GoalMember[]>;
}
export async function assignGoalMember(goalId: string, memberId: string, canEdit = false): Promise<void> {
  await api(`/api/goals/${goalId}/members`, { method: "POST", body: JSON.stringify({ memberId, canEdit }) });
}
export async function setGoalMemberEdit(goalId: string, memberId: string, canEdit: boolean): Promise<void> {
  await api(`/api/goals/${goalId}/members`, { method: "PATCH", body: JSON.stringify({ memberId, canEdit }) });
}
export async function unassignGoalMember(goalId: string, memberId: string): Promise<void> {
  await api(`/api/goals/${goalId}/members`, { method: "DELETE", body: JSON.stringify({ memberId }) });
}
export type MemberGoal = { id: string; name: string; emoji: string | null; status: string; parent_goal_id: string | null; can_edit: boolean };
export async function listMemberGoals(memberId: string): Promise<MemberGoal[]> {
  return (await api(`/api/members/${memberId}/goals`)) as MemberGoal[];
}

// ---------- node (task) members: who holds each task ----------
export type NodeMemberRow = { node_id: string; id: string; name: string; email: string | null; avatar: string | null; is_you: boolean };
export async function listNodeMembers(goalId: string): Promise<Record<string, NodeMemberRow[]>> {
  const rows = (await api(`/api/node-members?goal=${encodeURIComponent(goalId)}`)) as NodeMemberRow[];
  const map: Record<string, NodeMemberRow[]> = {};
  for (const r of rows) (map[r.node_id] ??= []).push(r);
  return map;
}
export async function assignNodeMember(nodeId: string, memberId: string): Promise<void> {
  await api("/api/node-members", { method: "POST", body: JSON.stringify({ nodeId, memberId }) });
}
export async function unassignNodeMember(nodeId: string, memberId: string): Promise<void> {
  await api("/api/node-members", { method: "DELETE", body: JSON.stringify({ nodeId, memberId }) });
}

// ---------- my tasks (items assigned to the logged-in user) ----------
export type MyTask = { id: string; name: string; emoji: string | null; status: string; parent_goal_id: string | null; parent_name: string | null; parent_emoji: string | null; started_at?: string | null; started_by_name?: string | null; started_via?: string | null; doing_at?: string | null; doing_by_name?: string | null; doing_via?: string | null; doing_count?: number };
export async function getMyTasks(): Promise<MyTask[]> {
  return (await api("/api/my-tasks")) as MyTask[];
}

// ---------- recursive items (goal == task; subtasks are child goals) ----------
export async function listTopGoals(): Promise<Goal[]> {
  return (await api("/api/goals?top=1")) as Goal[];
}
export async function listChildren(parentId: string): Promise<Goal[]> {
  return (await api(`/api/goals/${parentId}/children`)) as Goal[];
}
export async function createChild(parentId: string, name = ""): Promise<Goal> {
  return (await api(`/api/goals/${parentId}/children`, { method: "POST", body: JSON.stringify({ name }) })) as Goal;
}
// Re-parent / reorder a goal. parentId = null -> top level. beforeId = insert
// before that sibling (null/omitted -> append to the end of the destination).
export async function moveGoal(id: string, parentId: string | null, beforeId: string | null = null): Promise<void> {
  await api(`/api/goals/${id}/move`, { method: "POST", body: JSON.stringify({ parentId, beforeId }) });
}
export async function getAncestors(id: string): Promise<{ id: string; name: string }[]> {
  return (await api(`/api/goals/${id}/ancestors`)) as { id: string; name: string }[];
}
export async function toggleItemDone(id: string, done: boolean): Promise<void> {
  await api(`/api/goals/${id}/done`, { method: "PATCH", body: JSON.stringify({ done }) });
}
// 「開始」ボタン。started=false で進行中を取り消す (押し間違い用)
export async function setItemStarted(id: string, started: boolean): Promise<void> {
  await api(`/api/goals/${id}/start`, { method: "PATCH", body: JSON.stringify({ started }) });
}

// ---------- goal page bundle (fast transitions) ----------
// One request loads everything the goal page needs. Bundles are kept in a
// module-level cache so revisiting (or hover-prefetching) a goal renders
// instantly from cache while a fresh copy loads in the background.
export type GoalBundle = {
  goal: Goal;
  ancestors: { id: string; name: string }[];
  children: Goal[];
  resources: Resource[];
  comments: ChatMessage[];
  assignees: GoalMember[];
  childProgress: Record<string, { done: number; total: number }>;
  childAssignees: Record<string, GoalMember[]>;
};
const bundleCache = new Map<string, GoalBundle>();
const bundleInflight = new Map<string, Promise<GoalBundle>>();
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

export function cachedGoalBundle(id: string): GoalBundle | null {
  return bundleCache.get(id) ?? null;
}
export async function getGoalBundle(id: string): Promise<GoalBundle> {
  const b = (await api(`/api/goals/${id}/bundle`)) as GoalBundle;
  bundleCache.set(id, b);
  return b;
}
/**
 * Fire-and-forget warmup (e.g. on hover) so the next click paints instantly.
 * Debounced: sweeping the mouse across many rows only prefetches the row the
 * cursor settles on, instead of firing one request per row it crosses.
 */
export function prefetchGoalBundle(id: string): void {
  if (bundleCache.has(id) || bundleInflight.has(id)) return;
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    if (bundleCache.has(id) || bundleInflight.has(id)) return;
    const p = getGoalBundle(id).finally(() => bundleInflight.delete(id));
    bundleInflight.set(id, p);
    p.catch(() => {});
  }, 150);
}
