"use client";

// ゴール詳細のコメント欄 (一覧・@メンション候補・投稿・編集・取り消し)。app/goals/[id]/page.tsx から切り出し。
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type * as React from "react";
import { sendMessage, editMessage, deleteMessage, type Me, type GoalMember } from "../../lib/addness";
import type { Member, ChatMessage } from "../../lib/db";
import Linkified from "../Linkified";
import AutoGrowTextarea from "../AutoGrowTextarea";
import { I } from "./Icon";

export function CommentsPanel({ goalId, comments, setComments, loadComments, me, members, assignees, suppressNextCommentScrollRef }: {
  goalId: string;
  comments: ChatMessage[];
  setComments: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  loadComments: () => Promise<void>;
  me: Me | null;
  members: Member[];
  assignees: GoalMember[];
  /** true のときは次の comments 更新で下まで送らない (ゴールを開いた直後の読み込み) */
  suppressNextCommentScrollRef: MutableRefObject<boolean>;
}) {
  const id = goalId;
  const [commentBody, setCommentBody] = useState("");
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const commentEndRef = useRef<HTMLDivElement | null>(null);
  const lastCommentIdRef = useRef<string | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");

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

  return (
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
  );
}
