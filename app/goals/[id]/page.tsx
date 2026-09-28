"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps, type ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { getGoal, updateGoal, archiveGoal, createResource, updateResource, deleteResource, getMe, listMembers, assignGoalMember, unassignGoalMember, setGoalMemberEdit, listGoalMembersBatch, listChildren, createChild, toggleItemDone, sendMessage, editMessage, deleteMessage, createGoalInvite, getGoalBundle, cachedGoalBundle, prefetchGoalBundle, type GoalBundle } from "../../lib/addness";
import type { Goal, Resource, Member, ChatMessage } from "../../lib/db";
import type { Me, GoalMember } from "../../lib/addness";
import Linkified from "../../components/Linkified";
import { Assignees, Avatar } from "../../components/Assignees";
import { useAutoRefresh } from "../../lib/useAutoRefresh";

const PLACEHOLDER = "ここをタップして、達成したいゴールを入力しましょう！";

// 完了の基準・現状は AI と人が同じ文章を読んで動くところ。抽象的に書かれると
// 共有した意味が無くなるので、入力欄に良い例と悪い例をそのまま出す。
const CRITERIA_PLACEHOLDER = `× 「LPが良い感じになる」「営業を強化する」
○ 下のように、判定できる形で書く

・サービスLPを公開し、問い合わせフォームの送信をスマホ実機で確認
・9/30までに問い合わせ3件
・成果物: lp/index.html、計測用のGA4イベント設定`;

const STATE_PLACEHOLDER = `× 「進めている」「対応中」
○ 下のように、日付と残りを書く

9/12時点。ヒーローと料金表は実装済み、Vercelにデプロイ済み。
残り: 画像3点の発注、フォームの送信先結線。
詰まり: 先方のロゴデータ待ち（9/10に依頼、返信なし）。`;

function I({ d }: { d: string }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

// Textarea that grows to fit its content so all text is visible (no inner scroll).
function AutoGrowTextarea({ minRows = 3, style, onInput, ...rest }: ComponentProps<"textarea"> & { minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, minRows * 24)}px`;
  };
  useEffect(() => { fit(); }, []);
  return (
    <textarea
      ref={ref}
      {...rest}
      onInput={(e) => { fit(); onInput?.(e); }}
      style={{ overflow: "hidden", resize: "none", ...style }}
    />
  );
}

// Lazy, collapsible subtask tree shown inline under a goal-page task row.
function SubTree({ parentId, depth, router }: { parentId: string; depth: number; router: ReturnType<typeof useRouter> }) {
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
          <button onClick={() => toggleDone(k.id, !done)} className="w-5 h-5 shrink-0 rounded-full border flex items-center justify-center" style={done ? { background: "var(--done)", borderColor: "var(--done)" } : { borderColor: "var(--border-strong)" }} aria-label={done ? "未完了に戻す" : "完了にする"}>
            {done && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
          </button>
          <button onClick={() => router.push(`/goals/${k.id}`)} className={`flex-1 min-w-0 text-left text-[14px] truncate hover:underline ${done ? "done-label" : ""}`} title={k.name}>{k.name || "無題のタスク"}</button>
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

// One resource row: a file (click to toggle an inline preview below it), a
// link (external URL), or a legacy standalone note (title + multi-line body).
// File and link resources always carry a memo (content) explaining what they
// are — the UI no longer offers a bare "メモ" resource, only file+memo /
// link+memo pairs (existing standalone notes still render, just uncreatable).
function ResourceItem({ r, onChanged, bulkOpen }: { r: Resource; onChanged: () => void; bulkOpen?: { open: boolean; token: number } }) {
  // file source: R2-backed (url "r2:<key>") or legacy inline base64 (content data:)
  const fileHref =
    r.content && r.content.startsWith("data:") ? r.content
    : r.url && r.url.startsWith("r2:") ? `/api/files?key=${encodeURIComponent(r.url.slice(3))}`
    : null;
  const isFile = r.kind === "file" && !!fileHref;
  const isLink = r.kind === "link";
  const isImage = isFile && ((r.content || "").startsWith("data:image") || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(r.name));
  const isPdf = isFile && /\.pdf$/i.test(r.name);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(r.name);
  const [content, setContent] = useState(r.content ?? "");
  const [urlVal, setUrlVal] = useState(r.url ?? "");
  useEffect(() => { setName(r.name); setContent(r.content ?? ""); setUrlVal(r.url ?? ""); }, [r.id, r.name, r.content, r.url]);
  // "すべてプレビュー" header toggle drives every row at once, still overridable
  // per-row by clicking it individually afterward.
  useEffect(() => { if (bulkOpen) setOpen(bulkOpen.open); }, [bulkOpen?.token]);
  const saveName = async () => { const v = name.trim(); if (v && v !== r.name) { try { await updateResource(r.id, { name: v }); onChanged(); } catch { /* tolerate */ } } };
  const saveContent = async () => { if (content !== (r.content ?? "")) { try { await updateResource(r.id, { content }); onChanged(); } catch { /* tolerate */ } } };
  const saveUrl = async () => { const v = urlVal.trim(); if (v && v !== (r.url ?? "")) { try { await updateResource(r.id, { url: v }); onChanged(); } catch { /* tolerate */ } } };
  const del = async () => { try { await deleteResource(r.id); onChanged(); } catch { /* tolerate */ } };
  return (
    <li className="border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--hover)] group">
        <span className="text-[var(--muted-soft)] shrink-0">
          {isFile ? <I d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" />
            : isLink ? <I d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            : <I d="M4 6h16M4 12h16M4 18h10" />}
        </span>
        <button onClick={() => setOpen((v) => !v)} className="flex-1 min-w-0 text-sm truncate text-left hover:underline" title={isFile ? `${r.name}(クリックでプレビュー)` : r.name}>{r.name}</button>
        <span className="text-xs text-[var(--muted-soft)] shrink-0">{isFile ? "ファイル" : isLink ? "リンク" : r.kind}</span>
        {isFile && (
          <a href={fileHref!} download={r.name} className="shrink-0 text-[var(--muted-soft)] hover:text-[var(--accent)]" aria-label="ダウンロード" title="ダウンロード"><I d="M12 3v12M7 10l5 5 5-5M5 21h14" /></a>
        )}
        {isLink && (
          <a href={r.url ?? "#"} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[var(--muted-soft)] hover:text-[var(--accent)]" aria-label="新しいタブで開く" title="新しいタブで開く">
            <I d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3" />
          </a>
        )}
        {(isFile || isLink) && (
          <button onClick={() => setOpen((v) => !v)} className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--muted-soft)] hover:text-[var(--accent)]" aria-label="編集" title="編集">
            <I d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </button>
        )}
        <button onClick={del} className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--danger)]" aria-label="削除"><I d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></button>
      </div>
      {!open && (isFile || isLink) && r.content?.trim() && (
        <div className="px-4 pb-2 -mt-1 text-[12px] text-[var(--muted-soft)] truncate" title={r.content}>{r.content}</div>
      )}
      {open && (
        <div className="px-4 pb-3 pt-1 flex flex-col gap-2">
          {isLink && (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} placeholder="タイトル"
                className="w-full bg-[var(--hover)] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none" />
              <input value={urlVal} onChange={(e) => setUrlVal(e.target.value)} onBlur={saveUrl} placeholder="https://…"
                className="w-full bg-[var(--hover)] rounded-lg px-3 py-1.5 text-[13px] font-mono focus:outline-none" />
            </>
          )}
          {!isFile && !isLink && (
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} placeholder="タイトル"
              className="w-full bg-[var(--hover)] rounded-lg px-3 py-1.5 text-[13px] focus:outline-none" />
          )}
          <AutoGrowTextarea value={content} onChange={(e) => setContent(e.target.value)} onBlur={saveContent} minRows={isFile || isLink ? 2 : 3}
            placeholder={isFile ? "このファイルは何のファイルか説明(必須)" : isLink ? "このリンクは何か説明(必須)" : "内容を書く(改行できます)"}
            className="w-full bg-[var(--hover)] rounded-lg px-3 py-2 text-[13px] focus:outline-none" />
          {isFile && (
            isImage ? (
              <img src={fileHref!} alt={r.name} className="max-h-80 rounded-lg border" style={{ borderColor: "var(--border)" }} />
            ) : isPdf ? (
              <iframe src={fileHref!} title={r.name} className="w-full h-[420px] rounded-lg border" style={{ borderColor: "var(--border)" }} />
            ) : (
              <div className="text-[12px] text-[var(--muted-soft)]">このファイル形式はブラウザでプレビューできません。ダウンロードして確認してください。</div>
            )
          )}
        </div>
      )}
    </li>
  );
}

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
  const [assignPanel, setAssignPanel] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

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
  const [commentBody, setCommentBody] = useState("");
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const commentEndRef = useRef<HTMLDivElement | null>(null);
  const lastCommentIdRef = useRef<string | null>(null);
  // true = the next applyBundle is "just opened/switched goal" data, not a
  // live update — record the baseline but don't yank the view to the bottom.
  const suppressNextCommentScrollRef = useRef(true);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");

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

  const openAssignPanel = useCallback(async () => {
    setAssignPanel((v) => !v);
    if (members.length === 0) {
      try { setMembers((await listMembers()).filter((m) => !m.is_ai)); } catch {}
    }
  }, [members.length]);

  const toggleAssign = useCallback(async (memberId: string, assigned: boolean) => {
    try {
      if (assigned) await unassignGoalMember(id, memberId);
      else await assignGoalMember(id, memberId, false);
      await loadAssignees();
    } catch (e) { console.error(e); }
  }, [id, loadAssignees]);

  const toggleEdit = useCallback(async (memberId: string, canEdit: boolean) => {
    try { await setGoalMemberEdit(id, memberId, canEdit); await loadAssignees(); } catch (e) { console.error(e); }
  }, [id, loadAssignees]);

  // Create an invite link that only grants access to THIS task and its subtree.
  const makeInvite = useCallback(async () => {
    setInviteBusy(true);
    try {
      const { url } = await createGoalInvite(id);
      if (url) {
        setInviteUrl(url);
        try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ }
      }
    } catch (e) { console.error(e); }
    finally { setInviteBusy(false); }
  }, [id]);

  // ----- child item actions -----
  const toggleChildDone = useCallback(async (childId: string, done: boolean) => {
    setChildren((cs) => cs.map((c) => (c.id === childId ? { ...c, status: done ? "done" : "active" } : c)));
    try { await toggleItemDone(childId, done); } catch (e) { console.error(e); }
    loadChildren();
  }, [loadChildren]);

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

  // ----- comments -----
  const submitComment = useCallback(async () => {
    const v = commentBody.trim();
    if (!v || sending) return;
    setSending(true);
    setCommentBody("");
    setMentionQuery(null);
    try {
      await sendMessage(id, v);
      await loadComments();
    } catch (e) { console.error(e); }
    finally { setSending(false); }
  }, [commentBody, sending, id, loadComments]);

  // @mention autocomplete: trigger on an unclosed "@query" at the caret-less
  // end of the input (plain <input>, so we key off trailing text, not caret
  // position — comments are short one-liners so this is close enough).
  const onCommentChange = useCallback((v: string) => {
    setCommentBody(v);
    const m = v.match(/@([^\s@]*)$/);
    setMentionQuery(m ? m[1] : null);
  }, []);
  // このゴールのアサイン者を候補の先頭に出す。ワークスペース全員を登録順で
  // 並べていたので、実際にそのゴールを動かしている人が下に埋もれて選べず、
  // 「アサインされてる人をメンションできない」状態になっていた。
  const assignedMemberIds = new Set(assignees.map((a) => a.id));
  const memberIds = new Set(members.map((m) => m.id));
  // アサイン者はメンバー一覧の取得が失敗しても候補に出す (取得失敗は握り潰す
  // 作りなので、以前はその場合「全員」しか出せなかった)。
  const assignedOnly = assignees
    .filter((a) => !memberIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name }));
  const mentionCandidates = mentionQuery !== null
    ? [
        ...members.filter((m) => assignedMemberIds.has(m.id)),
        ...assignedOnly,
        { id: "__all__", name: "全員" },
        ...members.filter((m) => !assignedMemberIds.has(m.id)),
      ].filter((a) => a.name && a.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    : [];
  const pickMention = useCallback((name: string) => {
    setCommentBody((v) => v.replace(/@([^\s@]*)$/, `@${name} `));
    setMentionQuery(null);
  }, []);

  // A comment is "mine" if its author_email matches my login. Rows from before
  // author_email existed fall back to a display-name match.
  const myEmail = me?.email?.toLowerCase().trim() ?? null;
  const myMemberName = members.find((a) => a.email?.toLowerCase().trim() === myEmail)?.name ?? me?.name ?? null;
  const isMyComment = useCallback((m: ChatMessage) => {
    if (!me) return false;
    if (m.author_email) return !!myEmail && m.author_email === myEmail;
    return !!myMemberName && m.author === myMemberName;
  }, [me, myEmail, myMemberName]);

  const saveCommentEdit = useCallback(async (cid: string) => {
    const v = editCommentBody.trim();
    setEditingComment(null);
    if (!v) return;
    setComments((cs) => cs.map((c) => (c.id === cid ? { ...c, body: v, edited_at: new Date().toISOString() } : c)));
    try { await editMessage(cid, v); await loadComments(); } catch (e) { console.error(e); await loadComments(); }
  }, [editCommentBody, loadComments]);

  const removeComment = useCallback(async (cid: string) => {
    if (!confirm("このコメントを取り消しますか?")) return;
    setComments((cs) => cs.filter((c) => c.id !== cid));
    try { await deleteMessage(cid); } catch (e) { console.error(e); }
    await loadComments();
  }, [loadComments]);

  // 15s poll + realtime "changed" pings refetch this bundle constantly (any
  // MCP/AI action anywhere nudges every open goal page) — only auto-scroll
  // when a genuinely new comment shows up on an already-open goal, never on
  // the opening view (that would fight the "open a goal, land at the top" scroll).
  useEffect(() => {
    const lastId = comments.length ? comments[comments.length - 1].id : null;
    const suppress = suppressNextCommentScrollRef.current;
    suppressNextCommentScrollRef.current = false;
    if (lastId !== lastCommentIdRef.current) {
      lastCommentIdRef.current = lastId;
      if (lastId && !suppress) commentEndRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [comments]);

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
        <button
          onClick={() => toggleChildDone(c.id, !done)}
          className="w-5 h-5 shrink-0 rounded-full border flex items-center justify-center transition-colors"
          style={done ? { background: "var(--done)", borderColor: "var(--done)" } : { borderColor: "var(--border-strong)" }}
          aria-label={done ? "未完了に戻す" : "完了にする"}
        >
          {done && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
        </button>
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
            className={`flex-1 min-w-0 text-left text-[14.5px] truncate hover:underline ${done ? "done-label" : ""}`}
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
            {/* assignee zone: assigned goal-members + manage.
                オーナー欄 (projects.owner) は全ゴール一律「黒崎優斗」の固定文字列で、
                実体は goal_members のアサインなので、ヘッダーからは外した。 */}
            <div className="relative flex items-center gap-1.5">
              {assignees.length > 0 ? (
                canManage ? (
                  <button onClick={openAssignPanel} className="flex items-center rounded-full px-1 py-0.5 hover:bg-[var(--hover)]" aria-label="担当を変更" title="担当を変更">
                    <Assignees members={assignees} size={26} max={4} withName showLock />
                  </button>
                ) : (
                  <Assignees members={assignees} size={26} max={4} withName showLock />
                )
              ) : (
                canManage && <span className="text-[12px] text-[var(--muted-soft)]">未アサイン</span>
              )}
              {canManage && (
                <button onClick={openAssignPanel} className="w-7 h-7 shrink-0 rounded-full border border-dashed flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)]"
                  style={{ borderColor: "var(--border-strong)" }} aria-label="メンバーをアサイン"><I d="M12 5v14M5 12h14" /></button>
              )}
              {assignPanel && canManage && (() => {
                // 自分も候補に出す。以前は自分を除いていたが、そうすると自分が持つタスクに
                // 自分をアサインできない (下の行に「(自分)」の表示があるとおり、元々は
                // 出す作りだった)。アサインは担当を明示するためのもので、自分だけ例外に
                // する理由が無い。2026-09-09 黒崎指示。
                const assignable = members;
                return (
                <div className="absolute right-0 top-9 z-30 card w-[min(18rem,calc(100vw-2rem))] max-w-[18rem] max-h-80 overflow-y-auto" style={{ boxShadow: "var(--shadow-pop)" }} onMouseLeave={() => setAssignPanel(false)}>
                  <div className="px-4 py-2.5 border-b text-[12px] font-bold text-[var(--muted)]" style={{ borderColor: "var(--border)" }}>メンバーをアサイン</div>
                  {assignable.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[13px] text-[var(--muted-soft)]">メンバーがいません</div>
                  ) : (
                    <ul className="py-1">
                      {assignable.map((m) => {
                        const g = assignees.find((a) => a.id === m.id);
                        const assigned = !!g;
                        return (
                          <li key={m.id} className="px-3 py-2 hover:bg-[var(--hover)]">
                            <div className="flex items-center gap-2.5">
                              <Avatar member={{ id: m.id, name: m.name, email: m.email, avatar: m.avatar, can_edit: assigned ? !!g?.can_edit : undefined }} size={24} />
                              <span className="flex-1 text-[13.5px] truncate" title={m.name}>{m.name}{m.is_you && <span className="ml-1 text-[var(--muted-soft)]">(自分)</span>}</span>
                              <button onClick={() => toggleAssign(m.id, assigned)}
                                className={assigned ? "chip text-[var(--danger)]" : "chip"}>
                                {assigned ? "解除" : "アサイン"}
                              </button>
                            </div>
                            {assigned && (
                              <label className="flex items-center gap-1.5 mt-1.5 ml-[34px] text-[12px] text-[var(--muted)] cursor-pointer select-none">
                                <input type="checkbox" checked={!!g?.can_edit} onChange={(e) => toggleEdit(m.id, e.target.checked)} className="accent-[var(--accent)]" />
                                {g?.can_edit ? "編集を許可" : "閲覧のみ"}
                              </label>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
                    <button onClick={makeInvite} disabled={inviteBusy} className="chip w-full justify-center">{inviteBusy ? "作成中…" : "このタスクに招待リンク"}</button>
                    {inviteUrl && (
                      <div className="mt-2 text-[11px] break-all" style={{ color: "var(--muted)" }}>
                        コピー済み。招待された人はこのタスク以下だけ操作できます。<br />{inviteUrl}
                      </div>
                    )}
                  </div>
                </div>
                );
              })()}
            </div>
            <div className="relative">
              <button onClick={() => setMenu((v) => !v)} className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)]" aria-label="メニュー"><I d="M5 12h.01M12 12h.01M19 12h.01" /></button>
              {menu && (
                <div className="absolute right-0 top-9 z-20 card py-1 w-40" style={{ boxShadow: "var(--shadow-pop)" }} onMouseLeave={() => setMenu(false)}>
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
          <div className="flex items-center justify-between gap-3 mb-1">
            <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide" style={{ color: selfDone ? "var(--done-strong)" : "var(--accent)" }}>
              <I d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 12l3 2" />大ゴール（クリックで編集）
            </div>
            {selfDone ? (
              <div className="flex items-center gap-2 shrink-0">
                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold text-white" style={{ background: "var(--done)" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  完了
                </span>
                <button onClick={() => toggleSelfDone(false)} className="text-[12px] text-[var(--muted)] hover:text-[var(--foreground)] underline underline-offset-2">完了を取り消す</button>
              </div>
            ) : (
              <button
                onClick={() => toggleSelfDone(true)}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-bold text-white hover:opacity-90 transition-opacity"
                style={{ background: "var(--accent)" }}
                aria-label="このゴールを完了にする"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                完了にする
              </button>
            )}
          </div>
          <div className="flex items-start gap-2">
            {selfDone && (
              <span className="mt-2.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "var(--done)" }} title="完了">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
              </span>
            )}
            <textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              rows={1}
              placeholder={PLACEHOLDER}
              style={{ fontSize: title.length > 90 ? 16 : title.length > 60 ? 18 : title.length > 32 ? 21 : 24 }}
              className={`w-full resize-none bg-transparent font-bold leading-snug focus:outline-none placeholder:text-[var(--muted-soft)] placeholder:font-normal ${selfDone ? "text-[var(--muted)]" : ""}`}
            />
          </div>
        </div>
          );
        })()}

        {/* ===== 完了の基準・現状 (collapsed by default; MCP reads these, people see tasks+comments) ===== */}
        <div className="mb-4 rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <button
            type="button"
            onClick={() => setShowMeta((v) => !v)}
            aria-expanded={showMeta}
            className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-[var(--hover)]"
          >
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--muted)] min-w-0">
              <I d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /><span className="whitespace-nowrap">完了の基準・現状</span>
              {!showMeta && (
                <span className="font-normal text-[var(--muted-soft)] truncate hidden sm:inline">
                  {goal.completion_criteria?.trim() || goal.current_state?.trim() ? "（AIが読む欄。開いて確認・編集）" : "（未記入）"}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[var(--muted-soft)]" style={{ transform: showMeta ? "rotate(180deg)" : undefined, transition: "transform .15s" }}>
              <I d="M6 9l6 6 6-6" />
            </span>
          </button>
          {showMeta && (
            <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: "var(--border)" }}>
              <div className="text-xs font-semibold mb-1 mt-2" style={{ color: "var(--accent)" }}>完了の基準 — これが満たされたら完了</div>
              <p className="text-[11.5px] text-[var(--muted)] mb-1.5 cjk">
                他人が見て○×を付けられる形で書く。数字・日付・成果物の名前を必ず入れる。
                「検討する」「改善する」「いい感じにする」は基準にならない。
              </p>
              <AutoGrowTextarea
                defaultValue={goal.completion_criteria ?? ""}
                onBlur={(e) => patch({ completion_criteria: e.target.value })}
                placeholder={CRITERIA_PLACEHOLDER}
                minRows={5}
                className="w-full bg-white rounded-lg px-3 py-2 text-[14px] focus:outline-none border"
                style={{ borderColor: "#cdd9ff" }}
              />
              <div className="text-xs font-semibold text-[var(--muted)] mb-1 mt-3">現状 — 今どこまで進んでいるか</div>
              <p className="text-[11.5px] text-[var(--muted)] mb-1.5 cjk">
                日付から書き始めて「済んだこと / 残っていること / 詰まっていること」の3つを出す。
                「進めている」「対応中」だけだと、読んだ人が次の一手を判断できない。
              </p>
              <AutoGrowTextarea defaultValue={goal.current_state ?? ""} onBlur={(e) => patch({ current_state: e.target.value })}
                placeholder={STATE_PLACEHOLDER} minRows={5}
                className="w-full bg-[var(--hover)] rounded-lg px-3 py-2 text-sm focus:outline-none" />
            </div>
          )}
        </div>

        {/* ===== タスク (recursive child items) ===== */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2 gap-3">
            <h3 className="text-[16px] font-bold flex items-center gap-2">
              <I d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />タスク
            </h3>
            <span className="text-[11.5px] text-[var(--muted-soft)]">クリックで中に入れます（タスクの中にさらにタスク）</span>
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

        {/* ===== コメント ===== */}
        <div className="mt-8 lg:mt-0 lg:sticky lg:top-6 lg:h-[calc(100vh-9.5rem)] lg:flex lg:flex-col lg:min-h-0">
          <h3 className="text-[16px] font-bold mb-3 flex items-center gap-2 shrink-0">
            <I d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />コメント
            <span className="text-[13px] font-normal text-[var(--muted-soft)]">{comments.length}</span>
          </h3>
          <div className="card overflow-hidden lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
            <div className="max-h-80 lg:max-h-none lg:flex-1 lg:min-h-0 overflow-y-auto">
              {comments.length === 0 ? (
                <div className="px-4 py-10 text-center text-[13px] text-[var(--muted-soft)]">まだコメントはありません</div>
              ) : (
                <ul className="py-1">
                  {comments.map((m) => {
                    const name = m.author || "名無し";
                    const t = new Date(m.created_at);
                    const time = isNaN(t.getTime())
                      ? ""
                      : `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
                    const mine = isMyComment(m);
                    const editing = editingComment === m.id;
                    return (
                      <li key={m.id} className="group flex items-start gap-2.5 px-4 py-2.5">
                        <span className="w-7 h-7 shrink-0 rounded-full bg-[#7bc47f] text-white text-xs font-bold flex items-center justify-center" title={name}>{name[0]}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-[13px] font-bold truncate">{name}</span>
                            <span className="text-[11px] text-[var(--muted-soft)] shrink-0">{time}</span>
                            {m.edited_at && <span className="text-[11px] text-[var(--muted-soft)] shrink-0">(編集済み)</span>}
                            {mine && !editing && (
                              <span className="ml-auto shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => { setEditingComment(m.id); setEditCommentBody(m.body); }}
                                  className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)]"
                                  aria-label="コメントを編集"
                                ><I d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></button>
                                <button
                                  onClick={() => removeComment(m.id)}
                                  className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--muted)] hover:bg-[var(--hover)]"
                                  aria-label="コメントを取り消し"
                                ><I d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14" /></button>
                              </span>
                            )}
                          </div>
                          {editing ? (
                            <div className="mt-1">
                              <AutoGrowTextarea
                                value={editCommentBody}
                                onChange={(e) => setEditCommentBody(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); saveCommentEdit(m.id); }
                                  if (e.key === "Escape") setEditingComment(null);
                                }}
                                minRows={1}
                                autoFocus
                                className="w-full bg-[var(--hover)] rounded-lg px-3 py-2 text-[14px] focus:outline-none"
                              />
                              <div className="flex gap-2 mt-1">
                                <button onClick={() => saveCommentEdit(m.id)} className="text-[12px] px-2.5 py-1 rounded-md text-white" style={{ background: "var(--accent)" }}>保存</button>
                                <button onClick={() => setEditingComment(null)} className="text-[12px] px-2.5 py-1 rounded-md text-[var(--muted)] hover:bg-[var(--hover)]">キャンセル</button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-[14px] text-[var(--foreground)] whitespace-pre-wrap break-words"><Linkified text={m.body} mentionNames={["全員", ...members.map((a) => a.name)]} /></div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  <div ref={commentEndRef} />
                </ul>
              )}
            </div>
            <div className="relative flex items-end gap-2 px-3 py-2.5 border-t shrink-0" style={{ borderColor: "var(--border)" }}>
              {mentionCandidates.length > 0 && (
                <div className="absolute bottom-full left-3 mb-1 w-56 card max-h-60 overflow-y-auto z-10" style={{ boxShadow: "var(--shadow-pop)" }}>
                  {mentionCandidates.map((a) => (
                    <button
                      key={a.id}
                      onMouseDown={(e) => { e.preventDefault(); pickMention(a.name); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-[var(--hover)]"
                    >
                      <span className="w-5 h-5 shrink-0 rounded-full bg-[#7bc47f] text-white text-[10px] font-bold flex items-center justify-center">{a.name[0]}</span>
                      {a.name}
                      {assignedMemberIds.has(a.id) && (
                        <span className="ml-auto text-[10px] opacity-60">担当</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <AutoGrowTextarea
                value={commentBody}
                onChange={(e) => onCommentChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submitComment();
                  }
                }}
                minRows={1}
                placeholder="コメントを入力…(@で相手を指定、Shift+Enterで改行)"
                className="flex-1 min-w-0 bg-[var(--hover)] rounded-lg px-3 py-2 text-[14px] focus:outline-none"
              />
              <button
                onClick={submitComment}
                disabled={!commentBody.trim() || sending}
                className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-white transition-opacity disabled:opacity-40"
                style={{ background: "var(--accent)" }}
                aria-label="送信"
              >
                <I d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
