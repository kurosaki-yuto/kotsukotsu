"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listDone } from "../lib/queries";
import { supabase, type DoneEntry } from "../lib/db";
import { groupByDate, jstHourMinute } from "../lib/dateGroup";

export default function HistoryPage() {
  const [entries, setEntries] = useState<DoneEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      const data = await listDone({ limit: 500 });
      setEntries(data);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const ch = supabase()
      .channel("history-done")
      .on("postgres_changes", { event: "*", schema: "public", table: "done_log" }, () => refresh())
      .subscribe();
    return () => {
      supabase().removeChannel(ch);
    };
  }, []);

  const groups = groupByDate(entries);

  return (
    <div className="flex-1 min-h-0 h-screen overflow-y-auto" style={{ background: "var(--background)" }}>
      <header
        className="sticky top-0 z-10 px-8 py-4 border-b flex items-center gap-4"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <Link href="/" className="text-sm text-[var(--muted)] hover:underline">
          ← 戻る
        </Link>
        <h1 className="text-lg font-semibold">完了履歴</h1>
        <span className="text-xs text-[var(--muted)]">{entries.length} 件</span>
      </header>

      <main className="max-w-3xl mx-auto px-8 py-6 space-y-8">
        {loading && <div className="text-[var(--muted)]">読み込み中…</div>}
        {err && <pre className="text-red-500 text-xs whitespace-pre-wrap">{err}</pre>}
        {!loading && !err && groups.length === 0 && (
          <div className="text-[var(--muted)]">まだ完了履歴がない</div>
        )}
        {groups.map((g) => (
          <section key={g.key}>
            <h2 className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)] font-semibold mb-3">
              {g.label} — {g.items.length} 件
            </h2>
            <ul className="space-y-1 border-l-2 pl-4" style={{ borderColor: "var(--border)" }}>
              {g.items.map((e) => (
                <li key={e.id} className="py-2 flex items-start gap-3">
                  <span className="text-xs text-[var(--muted)] font-mono shrink-0 pt-0.5">
                    {jstHourMinute(e.completed_at)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">
                      {e.project_name && (
                        <span className="text-[var(--muted)] mr-2">[{e.project_name}]</span>
                      )}
                      {e.text}
                    </div>
                    {e.sub_md && (
                      <details className="mt-1">
                        <summary className="text-[11px] text-[var(--muted)] cursor-pointer">
                          サブ項目を表示
                        </summary>
                        <pre className="mt-1 text-xs whitespace-pre-wrap text-[var(--muted)] pl-2">
                          {e.sub_md}
                        </pre>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </div>
  );
}
