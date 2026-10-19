"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OfficeViewer } from "../../components/OfficeViewer";

// 上げた Word・Excel・PowerPoint を画面で開く (/files/view?key=…)。
// 型の資料・ゴールのリソース・この仕事の型 の「開く」から来る。読めるかどうかは /api/files が毎回確かめる。
export default function FileViewPage() {
  const router = useRouter();
  // ?key= は useSearchParams を使わずに読む (login と同じ。静的書き出しで Suspense 境界が要らないように)
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => { setKey(new URLSearchParams(window.location.search).get("key") ?? ""); }, []);

  if (key === null) return null;
  const name = key.split("/").pop()?.replace(/^[0-9a-f-]{36}-/, "") || "ファイル";
  return (
    <div className="flex flex-col h-[calc(100dvh-72px)] md:h-[calc(100dvh-40px)] px-4 md:px-8 py-4 gap-3">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <button type="button" className="chip" onClick={() => (history.length > 1 ? router.back() : router.push("/"))}>戻る</button>
        <h1 className="text-[15px] font-bold flex-1 min-w-0 truncate" title={name}>{name}</h1>
        {key && (
          <a href={`/api/files?key=${encodeURIComponent(key)}`} download={name} className="chip">ダウンロード</a>
        )}
      </div>
      {key ? (
        <OfficeViewer fileKey={key} className="flex-1" />
      ) : (
        <div className="text-[13px] text-[var(--muted-soft)]">開くファイルが指定されていません。</div>
      )}
    </div>
  );
}
