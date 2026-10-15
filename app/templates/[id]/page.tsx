"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  getTemplate,
  updateTemplate,
  archiveTemplate,
  applyTemplate,
  listMembers,
  listGoals,
  revertTemplateRevision,
  getTemplatePlaybooks,
  linkTemplatePlaybook,
  type TemplateDetail,
  type TemplatePrecedent,
} from "../../lib/addness";
import type { Goal, Member, TemplateCaution, TemplateInput, TemplateResource, TemplateTask } from "../../lib/db";
import { Avatar, Assignees } from "../../components/Assignees";
import AutoGrowTextarea from "../../components/AutoGrowTextarea";
import { tasksToOutline, outlineToTasks, countTasks, RESOURCE_KINDS } from "../../lib/server/templateCore";
import { useAutoRefresh } from "../../lib/useAutoRefresh";

const inputCls = "w-full rounded-lg px-3 py-2 text-[14px] focus:outline-none border";
const inputStyle = { background: "var(--hover)", borderColor: "var(--border)", color: "var(--foreground)" } as const;
const labelCls = "text-[11px] font-bold tracking-wide";

function TaskTreePreview({ tasks, depth = 0 }: { tasks: TemplateTask[]; depth?: number }) {
  return (
    <ul className={depth ? "ml-4 border-l pl-3" : ""} style={depth ? { borderColor: "var(--border)" } : undefined}>
      {tasks.map((t, i) => (
        <li key={`${depth}-${i}`} className="py-1 text-[13px] leading-snug">
          <span className="break-words">{t.text}</span>
          {t.completion_criteria && (
            <span className="ml-2 text-[11.5px]" style={{ color: "var(--muted)" }}>:: {t.completion_criteria}</span>
          )}
          {t.children && t.children.length > 0 && <TaskTreePreview tasks={t.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

// 型に結んだ前例 (以前この種類の仕事をしたときのやり方)。結ぶ・外すは型を直せる人だけ
function PrecedentsSection({ templateId, canManage }: { templateId: string; canManage: boolean }) {
  const [linked, setLinked] = useState<TemplatePrecedent[]>([]);
  const [candidates, setCandidates] = useState<TemplatePrecedent[]>([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async (query: string) => {
    try {
      const r = await getTemplatePlaybooks(templateId, query);
      setLinked(r.linked);
      setCandidates(r.candidates);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "前例を読めませんでした");
    }
  }, [templateId]);
  useEffect(() => { void reload(""); }, [reload]);
  const toggle = async (id: string, unlink: boolean) => {
    try {
      await linkTemplatePlaybook(templateId, id, unlink);
      await reload(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : "結べませんでした");
    }
  };
  const row = (p: TemplatePrecedent, action: "unlink" | "link" | null) => (
    <li key={p.id} className="py-2">
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="text-left text-[13px] leading-snug break-words hover:underline" onClick={() => setOpen((o) => (o === p.id ? null : p.id))}>
          {p.title}
          <span className="ml-2 text-[11px]" style={{ color: "var(--muted)" }}>{p.author_name ?? "記録なし"} · {p.updated_at.slice(0, 10)}</span>
        </button>
        {action && (
          <button type="button" className="text-[12px] underline underline-offset-2 whitespace-nowrap" style={action === "unlink" ? { color: "var(--danger)" } : undefined} onClick={() => void toggle(p.id, action === "unlink")}>
            {action === "unlink" ? "外す" : "結ぶ"}
          </button>
        )}
      </div>
      {open === p.id && (
        <div className="mt-1 rounded-lg px-3 py-2 text-[12.5px] whitespace-pre-wrap break-words" style={{ background: "var(--hover)" }}>
          {p.steps}
          {p.pitfalls && <div className="mt-2" style={{ color: "var(--muted)" }}>気をつけたこと: {p.pitfalls}</div>}
        </div>
      )}
    </li>
  );
  return (
    <section className="card px-5 py-4 mb-4">
      <h2 className="text-[14px] font-bold">前例 ({linked.length})</h2>
      <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
        以前この種類の仕事をしたときのやり方。この型から作ったタスクで残した前例は自動で結ばれます。
      </p>
      {error && <div className="mt-2 text-[12px]" style={{ color: "var(--danger)" }}>{error}</div>}
      {linked.length > 0 && <ul className="mt-2 flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>{linked.map((p) => row(p, canManage ? "unlink" : null))}</ul>}
      {canManage && (
        <div className="mt-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void reload(q); }}
            placeholder="前例を探して結ぶ (例: サムネ)  Enter で検索"
            className={inputCls}
            style={inputStyle}
          />
          {candidates.length > 0 && <ul className="mt-2 flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>{candidates.map((p) => row(p, "link"))}</ul>}
          {q.trim() && candidates.length === 0 && <div className="mt-2 text-[12px]" style={{ color: "var(--muted)" }}>Enter で検索します。結ばれていない前例だけが出ます。</div>}
        </div>
      )}
    </section>
  );
}

export default function TemplateDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id as string;
  const router = useRouter();
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [allGoals, setAllGoals] = useState<Goal[]>([]);

  // 編集中の値。保存は上の「保存」ボタンを押したときだけ (書き換えただけでは保存しない)
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [criteria, setCriteria] = useState("");
  const [inputs, setInputs] = useState<TemplateInput[]>([]);
  const [resources, setResources] = useState<TemplateResource[]>([]);
  const [cautions, setCautions] = useState<TemplateCaution[]>([]);
  const [outline, setOutline] = useState("");
  const [dirtyTasks, setDirtyTasks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 振る
  const [memberId, setMemberId] = useState("");
  const [parentId, setParentId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [deadline, setDeadline] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const load = useCallback(async (opts?: { withForm?: boolean }) => {
    try {
      const t = await getTemplate(id);
      setTpl(t);
      if (opts?.withForm) {
        setName(t.name);
        setPurpose(t.purpose ?? "");
        setCriteria(t.completion_criteria ?? "");
        setInputs(t.inputs);
        setResources(t.resources);
        setCautions(t.cautions);
        setOutline(tasksToOutline(t.tasks));
        setDirtyTasks(false);
      }
    } catch (e) {
      if (e instanceof Error && /not found/i.test(e.message)) setNotFound(true);
    }
  }, [id]);

  useEffect(() => {
    void load({ withForm: true });
    listMembers().then((ms) => setMembers(ms.filter((m) => !m.is_ai))).catch(() => {});
    listGoals({ activeOnly: true }).then(setAllGoals).catch(() => {});
  }, [load]);
  // 「この型から作ったゴール」は他の人の動きで変わるので定期的に取り直す (編集欄は触らない)
  useAutoRefresh(() => { void load(); }, { intervalMs: 30000 });

  const canManage = !!tpl?.can_manage;

  const dirty = !!tpl && (
    name !== tpl.name ||
    purpose !== (tpl.purpose ?? "") ||
    criteria !== (tpl.completion_criteria ?? "") ||
    JSON.stringify(inputs) !== JSON.stringify(tpl.inputs) ||
    JSON.stringify(resources) !== JSON.stringify(tpl.resources) ||
    JSON.stringify(cautions) !== JSON.stringify(tpl.cautions) ||
    dirtyTasks
  );

  // 保存していない書き換えがあるままページを離れようとしたら止める
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const saveAll = async () => {
    if (!tpl || !canManage || !dirty || !name.trim()) return;
    const keptResources = resources.filter((x) => x.url.trim());
    const noWhy = keptResources.filter((x) => !x.why?.trim());
    if (noWhy.length) {
      setSaveError(`資料に「何のために見るか」を書いてください: ${noWhy.map((x) => x.name || x.url).join("、")}`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const t = await updateTemplate(tpl.id, {
        name: name.trim(),
        purpose,
        completion_criteria: criteria,
        inputs: inputs.filter((x) => x.label.trim()),
        resources: keptResources,
        cautions: cautions.filter((x) => x.text.trim()),
        tasks: outlineToTasks(outline),
      });
      setTpl((p) => (p ? { ...p, ...t } : p));
      setName(t.name);
      setPurpose(t.purpose ?? "");
      setCriteria(t.completion_criteria ?? "");
      setInputs(t.inputs);
      setResources(t.resources);
      setCautions(t.cautions);
      setOutline(tasksToOutline(t.tasks));
      setDirtyTasks(false);
      setSavedAt(Date.now());
      const exportError = (t as { export_error?: string }).export_error;
      if (exportError) setSaveError(`保存しました。外 (GitHub) への書き出しに失敗: ${exportError}`);
      void load(); // 履歴を取り直す
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      setSaving(false);
    }
  };

  // 親ゴールの候補: 深さでインデント (members ページと同じ)
  const goalOptions = useMemo(() => {
    const byParent = new Map<string | null, Goal[]>();
    for (const g of allGoals) {
      const key = g.parent_goal_id ?? null;
      const b = byParent.get(key);
      if (b) b.push(g);
      else byParent.set(key, [g]);
    }
    const out: { goal: Goal; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const g of byParent.get(parent) ?? []) {
        out.push({ goal: g, depth });
        if (depth < 6) walk(g.id, depth + 1);
      }
    };
    walk(null, 0);
    const seen = new Set(out.map((o) => o.goal.id));
    for (const g of allGoals) if (!seen.has(g.id)) out.push({ goal: g, depth: 0 });
    return out;
  }, [allGoals]);

  const previewTasks = useMemo(() => outlineToTasks(outline), [outline]);
  const missingRequired = (tpl?.inputs ?? []).filter((i) => i.required && !(values[i.label] ?? "").trim());
  const canApply = !!memberId && !!parentId && missingRequired.length === 0 && !applying;

  const handleApply = async () => {
    if (!tpl || !canApply) return;
    setApplying(true);
    setApplyError(null);
    try {
      const r = await applyTemplate(tpl.id, { parentId, memberId, values, deadline: deadline || null });
      router.push(`/goals/${r.goalId}`);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "振れませんでした");
      setApplying(false);
    }
  };

  const handleDelete = async () => {
    if (!tpl) return;
    if (!window.confirm(`型「${tpl.name}」を削除しますか? (型の一覧から消えます。この型から作ったゴールは残ります)`)) return;
    try {
      await archiveTemplate(tpl.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "削除できませんでした");
      return;
    }
    router.push("/templates");
  };

  if (notFound) {
    return (
      <div className="min-h-full bg-white">
        <div className="max-w-3xl mx-auto px-4 md:px-10 py-9">
          <p className="text-[14px]">この型は見つかりませんでした。</p>
          <Link href="/templates" className="chip mt-4 inline-flex">型の一覧へ</Link>
        </div>
      </div>
    );
  }
  if (!tpl) {
    return (
      <div className="min-h-full bg-white">
        <div className="max-w-3xl mx-auto px-4 md:px-10 py-9 text-[13px]" style={{ color: "var(--muted)" }}>読み込み中…</div>
      </div>
    );
  }

  const ro = !canManage;

  return (
    <div className="min-h-full bg-white">
      <div className="max-w-3xl lg:max-w-[1360px] mx-auto px-4 md:px-10 py-7 pb-24 md:pb-10">
        <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
          <nav className="flex items-center gap-1 text-[13px] text-[var(--muted)] min-w-0 flex-wrap">
            <Link href="/templates" className="hover:text-[var(--foreground)]">型</Link>
            <span className="text-[var(--muted-soft)]">›</span>
            <span className="font-bold text-[var(--foreground)] truncate max-w-[16rem]">{tpl.name}</span>
          </nav>
          <div className="flex items-center gap-2 text-[12px] flex-wrap" style={{ color: "var(--muted)" }}>
            {saveError ? (
              <span style={{ color: "var(--danger)" }}>{saveError}</span>
            ) : saving ? "保存中…" : dirty ? "保存していない変更があります" : savedAt ? "保存しました" : null}
            {tpl.source_goal_id && (
              <Link href={`/goals/${tpl.source_goal_id}`} className="chip">元のゴール</Link>
            )}
            {canManage && (
              <>
                <button type="button" onClick={() => void handleDelete()} className="chip" style={{ color: "var(--danger)" }}>
                  削除
                </button>
                <button type="button" className="btn-dark" disabled={!dirty || saving || !name.trim()} onClick={() => void saveAll()}>
                  {saving ? "保存中…" : "保存"}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_420px] xl:grid-cols-[minmax(0,1fr)_460px] lg:gap-8 lg:items-start">
          {/* ===== 左: 型の中身 ===== */}
          <div className="min-w-0">
            <div className="rounded-2xl border px-5 py-4 mb-4" style={{ borderColor: "var(--border)", background: "#fafafa", borderLeft: "4px solid var(--accent)" }}>
              <div className={labelCls} style={{ color: "var(--accent)" }}>型の名前</div>
              <input
                value={name}
                readOnly={ro}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full bg-transparent text-[20px] font-bold focus:outline-none break-words"
                placeholder="例: 新規顧客のヒアリングから提案書を出すまで"
              />
              <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>何のための型か・期待する成果</div>
              <AutoGrowTextarea
                value={purpose}
                readOnly={ro}
                onChange={(e) => setPurpose(e.target.value)}
                className="mt-1 w-full bg-transparent text-[14px] leading-relaxed focus:outline-none"
                placeholder={"例: 初見の業界でも同じ順番で課題を構造化し、初回面談から 2 週間以内に提案書を出せる。\n過去 3 件はこの手順で受注率 2/3。"}
              />
              <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>新しいゴールの完了の基準 ({"{{入力}}"} で差し込める)</div>
              <AutoGrowTextarea
                value={criteria}
                readOnly={ro}
                onChange={(e) => setCriteria(e.target.value)}
                className="mt-1 w-full bg-transparent text-[13.5px] leading-relaxed focus:outline-none"
                placeholder={"この状態になったら完了。\n\n□ {{顧客名}} の課題を構造化シートに書き、先方と合意\n□ 提案書 PDF を {{期日}} までに送付"}
              />
            </div>

            {/* 必要な入力 */}
            <section className="card px-5 py-4 mb-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-bold">必要な入力 ({inputs.length})</h2>
                {!ro && (
                  <button type="button" className="chip" onClick={() => setInputs((p) => [...p, { label: "", hint: "", required: true }])}>+ 入力を足す</button>
                )}
              </div>
              <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                振るときに毎回変わる値 (顧客名・対象URL・件数など)。タスク名や完了の基準に {"{{ラベル}}"} と書くと差し込まれます。
              </p>
              {inputs.length > 0 && (
                <ul className="mt-3 flex flex-col gap-2">
                  {inputs.map((inp, i) => (
                    <li key={i} className="grid grid-cols-[1fr_auto] gap-2 items-start md:grid-cols-[180px_1fr_auto_auto]">
                      <input
                        value={inp.label}
                        readOnly={ro}
                        placeholder="ラベル (例: 顧客名)"
                        onChange={(e) => setInputs((p) => p.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                        className={inputCls}
                        style={inputStyle}
                      />
                      <input
                        value={inp.hint ?? ""}
                        readOnly={ro}
                        placeholder="ヒント (例: 正式名称。株式会社まで)"
                        onChange={(e) => setInputs((p) => p.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)))}
                        className={`${inputCls} col-span-2 md:col-span-1`}
                        style={inputStyle}
                      />
                      <label className="flex items-center gap-1.5 text-[12.5px] whitespace-nowrap" style={{ color: "var(--muted)" }}>
                        <input type="checkbox" disabled={ro} checked={!!inp.required} onChange={(e) => setInputs((p) => p.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
                        必須
                      </label>
                      {!ro && (
                        <button type="button" className="text-[12px] underline underline-offset-2 whitespace-nowrap" style={{ color: "var(--danger)" }} onClick={() => setInputs((p) => p.filter((_, j) => j !== i))}>削除</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 資料 */}
            <section className="card px-5 py-4 mb-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-bold">資料 ({resources.length})</h2>
                {!ro && (
                  <button type="button" className="chip" onClick={() => setResources((p) => [...p, { kind: "やり方", name: "", url: "", why: "" }])}>+ 資料を足す</button>
                )}
              </div>
              <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                本文はこつこつに入れず外 (手順書・実物・参考) に置き、ここには「どこを見ればいいか」だけを書きます。
                種類は やり方 (前回どうやったか) / 実物 (実際に出した成果物) / 置き場所 (型の本文の正本) / 情報源 (参考)。「何のために見るか」は必須です。振ると新しいゴールのリソースに付きます。
              </p>
              {resources.length > 0 && (
                <ul className="mt-3 flex flex-col gap-3">
                  {resources.map((r, i) => (
                    <li key={i} className="grid grid-cols-[96px_1fr_auto] md:grid-cols-[96px_180px_1fr_auto] gap-2 items-start rounded-xl border p-2" style={{ borderColor: "var(--border)" }}>
                      <select value={r.kind} disabled={ro} aria-label="資料の種類" onChange={(e) => setResources((p) => p.map((x, j) => (j === i ? { ...x, kind: e.target.value as TemplateResource["kind"] } : x)))} className={inputCls} style={inputStyle}>
                        {RESOURCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <input value={r.name} readOnly={ro} placeholder="名前" onChange={(e) => setResources((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={inputCls} style={inputStyle} />
                      <input value={r.url} readOnly={ro} placeholder="https://…" onChange={(e) => setResources((p) => p.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} className={`${inputCls} col-span-2 md:col-span-1 order-last md:order-none`} style={inputStyle} />
                      {!ro ? (
                        <button type="button" className="text-[12px] underline underline-offset-2 whitespace-nowrap self-center" style={{ color: "var(--danger)" }} onClick={() => setResources((p) => p.filter((_, j) => j !== i))}>削除</button>
                      ) : <span />}
                      <input value={r.why ?? ""} readOnly={ro} placeholder="何のために見るか (例: 顔の大きさと文字量の基準を見る)" onChange={(e) => setResources((p) => p.map((x, j) => (j === i ? { ...x, why: e.target.value } : x)))} className={`${inputCls} col-span-3 md:col-span-4 order-last`} style={{ ...inputStyle, ...(!r.why?.trim() && r.url.trim() ? { borderColor: "var(--danger)" } : {}) }} />
                      {ro && r.url && (
                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="col-span-3 md:col-span-4 text-[12px] underline underline-offset-2 order-last" style={{ color: "var(--accent)" }}>開く</a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 注意点 */}
            <section className="card px-5 py-4 mb-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-bold">注意点 ({cautions.length})</h2>
                {!ro && (
                  <button type="button" className="chip" onClick={() => setCautions((p) => [...p, { text: "" }])}>+ 注意点を足す</button>
                )}
              </div>
              <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                守らないと差し戻される所を 1 件 1 行で。差し戻しや照合の×が出ると、AI がここに自動で足します (履歴から戻せます)。
              </p>
              {cautions.length > 0 && (
                <ul className="mt-3 flex flex-col gap-2">
                  {cautions.map((c, i) => (
                    <li key={i} className="grid grid-cols-[1fr_auto] gap-2 items-start">
                      <div className="min-w-0">
                        <input value={c.text} readOnly={ro} placeholder="例: 実在の他人の顔を許諾なしで使わない" onChange={(e) => setCautions((p) => p.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className={inputCls} style={inputStyle} />
                        {(c.added_by || c.source_goal_id) && (
                          <div className="mt-0.5 text-[11px]" style={{ color: "var(--muted)" }}>
                            {c.added_at ? `${c.added_at.slice(0, 10)} ` : ""}{c.added_by ?? ""}
                            {c.source_goal_id && <> · <Link href={`/goals/${c.source_goal_id}`} className="underline underline-offset-2">きっかけのタスク</Link></>}
                          </div>
                        )}
                      </div>
                      {!ro && (
                        <button type="button" className="text-[12px] underline underline-offset-2 whitespace-nowrap mt-2" style={{ color: "var(--danger)" }} onClick={() => setCautions((p) => p.filter((_, j) => j !== i))}>削除</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <PrecedentsSection templateId={tpl.id} canManage={canManage} />

            {/* タスクの木 */}
            <section className="card px-5 py-4 mb-4">
              <h2 className="text-[14px] font-bold">タスク ({countTasks(previewTasks)})</h2>
              <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                1 行 1 タスク。行頭の空白 2 つで 1 段深くなります。「 :: 」の後ろは完了の基準。{"{{ラベル}}"} で入力値を差し込めます。
              </p>
              <AutoGrowTextarea
                value={outline}
                readOnly={ro}
                minRows={6}
                onChange={(e) => { setOutline(e.target.value); setDirtyTasks(true); }}
                className={`${inputCls} mt-3 font-mono text-[13px] leading-relaxed`}
                style={inputStyle}
                placeholder={"{{顧客名}} の HP と商談メモを読み、課題を構造化シートに書く :: シートの 7 項目が全部埋まっている\n  作れる/作れないを判定基準で判定する\n提案書のドラフトを書く :: PDF が 20_法務/ に置かれている"}
              />
              {previewTasks.length > 0 && (
                <div className="mt-3 rounded-xl border px-4 py-3" style={{ borderColor: "var(--border)", background: "var(--hover)" }}>
                  <div className={labelCls} style={{ color: "var(--muted)" }}>振ったときの見え方</div>
                  <TaskTreePreview tasks={previewTasks} />
                </div>
              )}
            </section>

            {canManage && (
              <div className="flex justify-end">
                <button type="button" className="btn-dark" disabled={!dirty || saving || !name.trim()} onClick={() => void saveAll()}>
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            )}
          </div>

          {/* ===== 右: 振る / 作ったゴール ===== */}
          <aside className="mt-6 lg:mt-0 lg:sticky lg:top-6 flex flex-col gap-4">
            <section className="card px-5 py-4">
              <h2 className="text-[14px] font-bold">この型で振る</h2>
              <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                担当者と置き場所を選び、入力を埋めて振ると、新しいゴール + タスク {countTasks(tpl.tasks)} 件 + 資料 {tpl.resources.length} 件が一度に入ります。注意点 {tpl.cautions.length} 件は、担当者の AI がタスクに入るときに読みます。
              </p>

              <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>担当者</div>
              {members.length === 0 ? (
                <div className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>メンバーがいません</div>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-1 max-h-56 overflow-y-auto pr-1">
                  {members.map((m) => (
                    <li key={m.id}>
                      <label className={`flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer ${memberId === m.id ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}>
                        <input type="radio" name="member" value={m.id} checked={memberId === m.id} onChange={() => setMemberId(m.id)} />
                        <Avatar member={{ id: m.id, name: m.name, email: m.email ?? undefined, avatar: m.avatar ?? undefined }} size={22} />
                        <span className="text-[13.5px] truncate">{m.name}{m.is_you ? " (自分)" : ""}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>置き場所 (親ゴール)</div>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={`${inputCls} mt-1.5`} style={inputStyle}>
                <option value="">ゴールを選択…</option>
                {goalOptions.map(({ goal, depth }) => (
                  <option key={goal.id} value={goal.id}>
                    {`${"　".repeat(depth)}${goal.emoji ? `${goal.emoji} ` : ""}${goal.name}`}
                  </option>
                ))}
              </select>

              {tpl.inputs.length > 0 && (
                <>
                  <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>入力</div>
                  <div className="mt-1.5 flex flex-col gap-2">
                    {tpl.inputs.map((inp) => (
                      <label key={inp.label} className="block">
                        <span className="text-[12.5px] font-bold">
                          {inp.label}
                          {inp.required && <span className="ml-1" style={{ color: "var(--danger)" }}>*</span>}
                        </span>
                        {inp.hint && <span className="ml-2 text-[11.5px]" style={{ color: "var(--muted)" }}>{inp.hint}</span>}
                        <input
                          value={values[inp.label] ?? ""}
                          onChange={(e) => setValues((p) => ({ ...p, [inp.label]: e.target.value }))}
                          className={`${inputCls} mt-1`}
                          style={inputStyle}
                        />
                      </label>
                    ))}
                  </div>
                </>
              )}

              <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>期日 (任意)</div>
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={`${inputCls} mt-1.5`} style={inputStyle} />

              {applyError && <div className="mt-3 text-[12.5px]" style={{ color: "var(--danger)" }}>{applyError}</div>}
              <button type="button" className="btn-dark w-full mt-4" disabled={!canApply} onClick={() => void handleApply()}>
                {applying ? "振っています…" : "この内容で振る"}
              </button>
              {missingRequired.length > 0 && (
                <div className="mt-2 text-[11.5px]" style={{ color: "var(--muted)" }}>必須: {missingRequired.map((i) => i.label).join("、")}</div>
              )}
            </section>

            <section className="card px-5 py-4">
              <h2 className="text-[14px] font-bold">この型から作ったゴール ({tpl.goals.length})</h2>
              {tpl.goals.length === 0 ? (
                <div className="mt-2 text-[12.5px]" style={{ color: "var(--muted)" }}>まだありません</div>
              ) : (
                <ul className="mt-2 flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
                  {tpl.goals.map((g) => (
                    <li key={g.id} className="py-2">
                      <Link href={`/goals/${g.id}`} className="flex items-start gap-2 hover:underline">
                        <span
                          className="mt-1 inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ background: g.status === "done" ? "var(--done)" : "var(--accent)" }}
                          aria-label={g.status === "done" ? "完了" : "進行中"}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13.5px] leading-snug break-words">{g.name}</span>
                          <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
                            {g.created_at.slice(0, 10)}{g.deadline ? ` · 期日 ${g.deadline}` : ""}{g.status === "done" ? " · 完了" : ""}
                          </span>
                        </span>
                        {g.assignees.length > 0 && <Assignees members={g.assignees} size={20} />}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {tpl.export_url && (
              <section className="card px-5 py-4">
                <h2 className="text-[14px] font-bold">型の置き場所 (外)</h2>
                <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
                  型を直すたびに書き出しています。こつこつが止まっても、ここから資料と注意点に辿れます。
                </p>
                <a href={tpl.export_url} target="_blank" rel="noopener noreferrer" className="mt-2 block text-[12.5px] underline underline-offset-2 break-all" style={{ color: "var(--accent)" }}>{tpl.export_url}</a>
                {tpl.exported_at && <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>最後に書き出した日時: {tpl.exported_at.slice(0, 16).replace("T", " ")}</div>}
                {tpl.exported_at && tpl.exported_at < tpl.updated_at && (
                  <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>型を直したあと、まだ書き出していません。次に AI がこの型に触れたときに書き直します。</div>
                )}
              </section>
            )}

            <section className="card px-5 py-4">
              <h2 className="text-[14px] font-bold">直した履歴 ({tpl.revisions.length})</h2>
              {tpl.revisions.length === 0 ? (
                <div className="mt-2 text-[12.5px]" style={{ color: "var(--muted)" }}>まだありません</div>
              ) : (
                <ul className="mt-2 flex flex-col divide-y" style={{ borderColor: "var(--border)" }}>
                  {tpl.revisions.map((r) => (
                    <li key={r.id} className="py-2 text-[12.5px]">
                      <div className="flex items-center justify-between gap-2">
                        <span style={{ color: "var(--muted)" }}>
                          {r.created_at.slice(0, 16).replace("T", " ")} · {r.actor_name ?? "記録なし"}{r.actor_kind === "ai" ? " (AI)" : ""}
                        </span>
                        {canManage && !r.reverted_at && (
                          <button
                            type="button"
                            className="text-[12px] underline underline-offset-2 whitespace-nowrap"
                            onClick={async () => {
                              if (dirty && !window.confirm("保存していない変更は消えます。この版の変更を取り消しますか?")) return;
                              try {
                                await revertTemplateRevision(tpl.id, r.id);
                                await load({ withForm: true });
                              } catch (e) {
                                setSaveError(e instanceof Error ? e.message : "戻せませんでした");
                              }
                            }}
                          >
                            この変更を戻す
                          </button>
                        )}
                        {r.reverted_at && <span className="text-[11px]" style={{ color: "var(--muted)" }}>戻し済み</span>}
                      </div>
                      {r.reason && <div className="mt-0.5 break-words">{r.reason}</div>}
                      {r.changes.length > 0 && (
                        <ul className="mt-0.5 text-[11.5px] list-disc pl-4" style={{ color: "var(--muted)" }}>
                          {r.changes.slice(0, 6).map((c, k) => <li key={k} className="break-words">{c}</li>)}
                        </ul>
                      )}
                      {r.source_goal_id && <Link href={`/goals/${r.source_goal_id}`} className="text-[11.5px] underline underline-offset-2">きっかけのタスク</Link>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
