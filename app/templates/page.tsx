"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listTemplates, createTemplate, getMe, type Me } from "../lib/addness";
import type { TemplateSummary } from "../lib/db";
import { TEMPLATE_FUNCTIONS, VISIBILITY_LABEL, describeSchedule } from "../lib/server/templateCore";
import { useAutoRefresh } from "../lib/useAutoRefresh";

// 型 (テンプレート) の一覧。型 = 必要な入力値 + 資料リンク + タスクの木。
// 終えたゴールの「…」→「型にする」で作り、ここから「この型で振る」でメンバーに丸ごと渡す。
// 機能 (経営・財務・法務・集客・営業・CS・その他) ごとの見出しで並べる。読める型だけが返ってくる (見える範囲)。

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function TemplatesPage() {
  const router = useRouter();
  const [items, setItems] = useState<TemplateSummary[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await listTemplates());
    } catch {
      /* api() が上部のバナーで知らせる。空にすり替えない */
    }
  }, []);
  useEffect(() => {
    void load();
    getMe().then((r) => setMe(r.user)).catch(() => {});
  }, [load]);
  useAutoRefresh(() => { void load(); });

  const admin = me?.role === "admin";
  const handleCreate = async () => {
    setCreating(true);
    try {
      const t = await createTemplate({ name: "新しい型" });
      router.push(`/templates/${t.id}`);
    } catch {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-full bg-white">
      <div className="max-w-3xl lg:max-w-[1360px] mx-auto px-4 md:px-10 py-9 pb-24 md:pb-12">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-1">
          <h1 className="text-[22px] font-bold">型</h1>
          {admin && (
            <button type="button" onClick={handleCreate} disabled={creating} className="btn-dark shrink-0">
              + 新しい型
            </button>
          )}
        </div>
        <p className="text-[13px] mb-6" style={{ color: "var(--muted)" }}>
          型 = 必要な入力値 + 資料リンク + タスクの木。終えたゴールの「…」→「型にする」で作り、「この型で振る」でメンバーに丸ごと渡せます。
        </p>

        {items === null ? (
          <div className="text-[13px]" style={{ color: "var(--muted)" }}>読み込み中…</div>
        ) : items.length === 0 ? (
          <div className="card px-5 py-8 text-center text-[13.5px]" style={{ color: "var(--muted)" }}>
            まだ型がありません。終えたゴールを開き、右上の「…」→「型にする」で作れます。
          </div>
        ) : (
          <div className="flex flex-col gap-7">
            {[...TEMPLATE_FUNCTIONS, null].map((fn) => {
              const group = items.filter((t) => (t.function ?? null) === fn);
              if (!group.length) return null;
              return (
                <section key={fn ?? "none"} aria-label={fn ?? "未分類"}>
                  <h2 className="mb-2.5 flex items-baseline gap-2 text-[14px] font-bold cjk">
                    {fn ?? "未分類"}
                    <span className="text-[12px] font-normal" style={{ color: "var(--muted)" }}>{group.length}</span>
                  </h2>
                  <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {group.map((t) => (
                      <li key={t.id}>
                        <Link
                          href={`/templates/${t.id}`}
                          className="card block px-5 py-4 h-full hover:shadow-md transition-shadow"
                          style={{ borderLeft: "4px solid var(--accent)" }}
                        >
                          <div className="font-bold text-[15px] leading-snug break-words">{t.name}</div>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <span className="rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--foreground-soft)" }}>
                              見える: {VISIBILITY_LABEL[t.visibility] ?? "全員"}
                            </span>
                            {t.schedule && (
                              <span className="rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: "var(--doing-border)", background: "var(--doing-soft)", color: "var(--doing)" }}>
                                {describeSchedule(t.schedule)}
                              </span>
                            )}
                          </div>
                          {t.purpose && (
                            <p className="mt-1.5 text-[12.5px] leading-relaxed line-clamp-3 break-words" style={{ color: "var(--foreground-soft)" }}>
                              {t.purpose}
                            </p>
                          )}
                          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px]" style={{ color: "var(--muted)" }}>
                            <span>入力 {t.inputs.length}</span>
                            <span>タスク {t.task_count}</span>
                            <span>資料 {t.resources.length}</span>
                            <span>使った回数 {t.used_count}</span>
                          </div>
                          <div className="mt-2 text-[11.5px]" style={{ color: "var(--muted-soft)" }}>
                            {t.author_name ?? "—"} · 更新 {fmtDate(t.updated_at)}
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
