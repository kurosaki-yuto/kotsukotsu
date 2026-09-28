"use client";

import { useCallback, useEffect, useState } from "react";
import { FETCH_ERROR_EVENT, FETCH_OK_EVENT } from "../lib/addness";

// Most screens fall back to an empty list when a request fails, so a broken
// backend has historically been indistinguishable from "you have nothing here"
// (assignee avatars disappearing, notifications going missing). The request
// layer announces every failure; this turns it into something the viewer can
// actually see, so nobody has to guess whether a blank screen is real.
//
// A failure sticks until a later request on the same path succeeds — an
// isolated 500 during a 15s poll shouldn't leave a permanent banner, but a
// consistently failing endpoint should stay loud.
export default function LoadFailureBanner() {
  const [failed, setFailed] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const onError = (e: Event) => {
      const d = (e as CustomEvent).detail as { path?: string; status?: number; message?: string } | undefined;
      if (!d?.path) return;
      setFailed((prev) => {
        const next = new Map(prev);
        next.set(key(d.path!), d.message || `HTTP ${d.status ?? "error"}`);
        return next;
      });
    };
    const onOk = (e: Event) => {
      const d = (e as CustomEvent).detail as { path?: string } | undefined;
      if (!d?.path) return;
      setFailed((prev) => {
        if (!prev.has(key(d.path!))) return prev;
        const next = new Map(prev);
        next.delete(key(d.path!));
        return next;
      });
    };
    window.addEventListener(FETCH_ERROR_EVENT, onError);
    window.addEventListener(FETCH_OK_EVENT, onOk);
    return () => {
      window.removeEventListener(FETCH_ERROR_EVENT, onError);
      window.removeEventListener(FETCH_OK_EVENT, onOk);
    };
  }, []);

  const retry = useCallback(() => window.location.reload(), []);

  if (failed.size === 0) return null;
  const what = [...failed.keys()].map(label).join("・");
  return (
    <div
      role="alert"
      className="flex items-center gap-3 px-4 py-2 text-sm"
      style={{ background: "#fdf1f1", borderBottom: "1px solid #f0c9c9", color: "#8c2f2f" }}
    >
      <span className="flex-1 min-w-0 cjk">
        {what}の読み込みに失敗しています。表示が空でも、実際には中身がある可能性があります。
      </span>
      <button type="button" onClick={retry} className="chip shrink-0">
        再読み込み
      </button>
    </div>
  );
}

// group by endpoint, ignoring query strings and ids, so a polling loop doesn't
// pile up one entry per request
function key(path: string): string {
  return path.split("?")[0].replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id");
}

const LABELS: Array<[RegExp, string]> = [
  [/^\/api\/notifications/, "通知"],
  [/^\/api\/goals\/:id\/members/, "担当者"],
  [/^\/api\/goal-members/, "担当者"],
  [/^\/api\/goals/, "タスク"],
  [/^\/api\/my-tasks/, "自分のタスク"],
  [/^\/api\/members/, "メンバー"],
  [/^\/api\/chat/, "コメント"],
  [/^\/api\/today/, "今日のタスク"],
];
function label(k: string): string {
  for (const [re, name] of LABELS) if (re.test(k)) return name;
  return "データ";
}
