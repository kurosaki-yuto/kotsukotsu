"use client";

// リソース 1 行 (ファイル / リンク / 旧メモ)。app/goals/[id]/page.tsx から切り出し。
import { useEffect, useState } from "react";
import { updateResource, deleteResource } from "../../lib/addness";
import type { Resource } from "../../lib/db";
import AutoGrowTextarea from "../AutoGrowTextarea";
import { I } from "./Icon";

// One resource row: a file (click to toggle an inline preview below it), a
// link (external URL), or a legacy standalone note (title + multi-line body).
// File and link resources always carry a memo (content) explaining what they
// are — the UI no longer offers a bare "メモ" resource, only file+memo /
// link+memo pairs (existing standalone notes still render, just uncreatable).
export function ResourceItem({ r, onChanged, bulkOpen }: { r: Resource; onChanged: () => void; bulkOpen?: { open: boolean; token: number } }) {
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
  useEffect(() => { if (bulkOpen) setOpen(bulkOpen.open); }, [bulkOpen]);
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
