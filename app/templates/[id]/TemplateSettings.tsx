"use client";

import { useEffect, useState } from "react";
import { updateTemplate, type TemplateDetail } from "../../lib/addness";
import type { Goal, Member, TemplateFunction, TemplateSchedule, TemplateVisibility } from "../../lib/db";
import { TEMPLATE_FUNCTIONS, TEMPLATE_VISIBILITIES, VISIBILITY_LABEL, describeSchedule } from "../../lib/server/templateCore";

// 型の「機能・見える範囲・自分だけのメモ・繰り返し」(2026-11-02 黒崎承認)。中身 (名前・タスク等) の保存とは別に保存する。
// 直せるのは管理者と作った本人。それ以外の人には 1 行の読み取り表示だけ出す (メモと振る先はサーバーが返さない)。
const inputCls = "w-full rounded-lg px-3 py-2 text-[14px] focus:outline-none border";
const inputStyle = { background: "var(--hover)", borderColor: "var(--border)", color: "var(--foreground)" } as const;
const labelCls = "text-[11px] font-bold tracking-wide";
const VIS_HINT: Record<TemplateVisibility, string> = {
  private: "作った人と管理者だけが読めます",
  assigned: "この型から作ったゴールの担当者も読めます。担当を外れると読めなくなります",
  workspace: "メンバー全員が読めます",
};
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
type Freq = "none" | TemplateSchedule["freq"];

export default function TemplateSettings({ tpl, members, goalOptions, onSaved }: {
  tpl: TemplateDetail;
  members: Member[];
  goalOptions: { goal: Goal; depth: number }[];
  onSaved: (t: TemplateDetail) => void;
}) {
  const [fn, setFn] = useState<TemplateFunction | "">(tpl.function ?? "");
  const [vis, setVis] = useState<TemplateVisibility>(tpl.visibility);
  const [note, setNote] = useState(tpl.private_note ?? "");
  const [freq, setFreq] = useState<Freq>(tpl.schedule?.freq ?? "none");
  const [time, setTime] = useState(tpl.schedule?.time ?? "09:00");
  const [weekday, setWeekday] = useState(tpl.schedule?.weekday ?? 1);
  const [day, setDay] = useState(tpl.schedule?.day ?? 1);
  const [memberId, setMemberId] = useState(tpl.schedule_target?.member_id ?? "");
  const [parentId, setParentId] = useState(tpl.schedule_target?.parent_id ?? "");
  const [values, setValues] = useState<Record<string, string>>(tpl.schedule_target?.values ?? {});
  const [deadlineDays, setDeadlineDays] = useState(tpl.schedule_target?.deadline_days?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // 別の人・AI が直したら、こちらで書き換えていない欄だけ取り直すと食い違うので、保存した直後と型が変わったときに全部取り直す
  useEffect(() => {
    setFn(tpl.function ?? "");
    setVis(tpl.visibility);
    setNote(tpl.private_note ?? "");
    setFreq(tpl.schedule?.freq ?? "none");
    setTime(tpl.schedule?.time ?? "09:00");
    setWeekday(tpl.schedule?.weekday ?? 1);
    setDay(tpl.schedule?.day ?? 1);
    setMemberId(tpl.schedule_target?.member_id ?? "");
    setParentId(tpl.schedule_target?.parent_id ?? "");
    setValues(tpl.schedule_target?.values ?? {});
    setDeadlineDays(tpl.schedule_target?.deadline_days?.toString() ?? "");
  }, [tpl.id, tpl.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tpl.can_manage) {
    return (
      <section className="card px-5 py-3.5 text-[12.5px]" style={{ color: "var(--muted)" }}>
        機能: <b style={{ color: "var(--foreground)" }}>{tpl.function ?? "未分類"}</b>
        <span className="mx-2">·</span>見える: <b style={{ color: "var(--foreground)" }}>{VISIBILITY_LABEL[tpl.visibility]}</b>
        {tpl.schedule && <><span className="mx-2">·</span>{describeSchedule(tpl.schedule)} に自動で振られます</>}
      </section>
    );
  }

  const schedule: TemplateSchedule | null =
    freq === "none" ? null
      : freq === "weekly" ? { freq, time, weekday }
        : freq === "monthly" ? { freq, time, day }
          : { freq, time };
  const missing = freq === "none" ? [] : tpl.inputs.filter((i) => i.required && !(values[i.label] ?? "").trim()).map((i) => i.label);
  const canSave = !saving && (freq === "none" || (!!memberId && !!parentId && missing.length === 0));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setMsg(null);
    try {
      const dd = deadlineDays.trim() === "" ? undefined : Number(deadlineDays);
      const t = await updateTemplate(tpl.id, {
        function: (fn || null) as TemplateFunction | null,
        visibility: vis,
        private_note: note,
        schedule,
        schedule_target: schedule ? { parent_id: parentId, member_id: memberId, values, ...(dd !== undefined && Number.isFinite(dd) ? { deadline_days: dd } : {}) } : null,
      });
      onSaved(t);
      setMsg({ ok: true, text: "保存しました" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "保存できませんでした" });
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!tpl.routine_setup) return;
    try {
      await navigator.clipboard.writeText(tpl.routine_setup);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMsg({ ok: false, text: "コピーできませんでした。下の文を選んでコピーしてください" });
    }
  };

  return (
    <section className="card px-5 py-4" aria-label="型の設定">
      <h2 className="text-[14px] font-bold">型の設定</h2>

      <div className={`${labelCls} mt-3`} style={{ color: "var(--muted)" }}>機能</div>
      <select value={fn} onChange={(e) => setFn(e.target.value as TemplateFunction | "")} className={`${inputCls} mt-1.5`} style={inputStyle}>
        <option value="">未分類</option>
        {TEMPLATE_FUNCTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>

      <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>見える範囲</div>
      <div className="mt-1.5 flex flex-col gap-1">
        {TEMPLATE_VISIBILITIES.map((v) => (
          <label key={v} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 cursor-pointer ${vis === v ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}>
            <input type="radio" name="visibility" className="mt-1" checked={vis === v} onChange={() => setVis(v)} />
            <span>
              <span className="text-[13.5px] font-bold">{VISIBILITY_LABEL[v]}</span>
              <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>{VIS_HINT[v]}</span>
            </span>
          </label>
        ))}
      </div>

      <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>自分だけのメモ</div>
      <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--muted)" }}>作った人と管理者にだけ見えます。道具の置き場所・アカウントなど、振った相手に見せないものはここへ。</p>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={4000} className={`${inputCls} mt-1.5 text-[13px] leading-relaxed`} style={inputStyle} />

      <div className={`${labelCls} mt-4`} style={{ color: "var(--muted)" }}>繰り返し</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <select value={freq} onChange={(e) => setFreq(e.target.value as Freq)} className={`${inputCls} !w-auto`} style={inputStyle}>
          <option value="none">繰り返さない</option>
          <option value="daily">毎日</option>
          <option value="weekly">毎週</option>
          <option value="monthly">毎月</option>
        </select>
        {freq === "weekly" && (
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={`${inputCls} !w-auto`} style={inputStyle} aria-label="曜日">
            {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}曜</option>)}
          </select>
        )}
        {freq === "monthly" && (
          <select value={day} onChange={(e) => setDay(Number(e.target.value))} className={`${inputCls} !w-auto`} style={inputStyle} aria-label="日">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}日</option>)}
          </select>
        )}
        {freq !== "none" && (
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${inputCls} !w-auto`} style={inputStyle} aria-label="時刻" />
        )}
      </div>

      {freq !== "none" && (
        <div className="mt-3 rounded-xl border px-3 py-3" style={{ borderColor: "var(--border)" }}>
          <p className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            時刻になると、こつこつがこの内容で今回分のゴールを作り、担当の今日に入れて知らせます。前回分が終わっていなければ作りません。
          </p>
          <div className={`${labelCls} mt-3`} style={{ color: "var(--muted)" }}>担当</div>
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className={`${inputCls} mt-1.5`} style={inputStyle}>
            <option value="">担当を選択…</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.is_you ? " (自分)" : ""}</option>)}
          </select>
          <div className={`${labelCls} mt-3`} style={{ color: "var(--muted)" }}>置き場所 (親ゴール)</div>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={`${inputCls} mt-1.5`} style={inputStyle}>
            <option value="">ゴールを選択…</option>
            {goalOptions.map(({ goal, depth }) => (
              <option key={goal.id} value={goal.id}>{`${"　".repeat(depth)}${goal.emoji ? `${goal.emoji} ` : ""}${goal.name}`}</option>
            ))}
          </select>
          {tpl.inputs.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {tpl.inputs.map((inp) => (
                <label key={inp.label} className="block">
                  <span className="text-[12.5px] font-bold">
                    {inp.label}{inp.required && <span className="ml-1" style={{ color: "var(--danger)" }}>*</span>}
                  </span>
                  {inp.hint && <span className="ml-2 text-[11.5px]" style={{ color: "var(--muted)" }}>{inp.hint}</span>}
                  <input value={values[inp.label] ?? ""} onChange={(e) => setValues((p) => ({ ...p, [inp.label]: e.target.value }))} className={`${inputCls} mt-1`} style={inputStyle} />
                </label>
              ))}
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-[12.5px]">
            期限は振った日の
            <input type="number" min={0} max={365} value={deadlineDays} onChange={(e) => setDeadlineDays(e.target.value)} className={`${inputCls} !w-20`} style={inputStyle} />
            日後 (空なら期限なし)
          </label>
          {missing.length > 0 && <div className="mt-2 text-[11.5px]" style={{ color: "var(--muted)" }}>必須: {missing.join("、")}</div>}
        </div>
      )}

      {msg && <div className="mt-3 text-[12.5px]" style={{ color: msg.ok ? "var(--done-strong)" : "var(--danger)" }}>{msg.text}</div>}
      <button type="button" className="btn-dark w-full mt-3" disabled={!canSave} onClick={() => void save()}>
        {saving ? "保存中…" : "設定を保存"}
      </button>

      {tpl.schedule && tpl.routine_setup && (
        <div className="mt-4 rounded-xl border px-3 py-3" style={{ borderColor: "var(--doing-border)", background: "var(--doing-soft)" }}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-bold" style={{ color: "var(--doing)" }}>AI の定期実行の組み方</span>
            <button type="button" className="chip" onClick={() => void copy()}>{copied ? "コピーしました" : "AI に渡す文をコピー"}</button>
          </div>
          <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
            手順を最後まで回すのは AI です。この文を Claude に渡すと、こつこつが作った15分後に動く定期実行を組みます。
            {tpl.last_run_at && <> 前回こつこつが振った日時: {new Date(tpl.last_run_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}
          </p>
          <pre className="mt-2 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>{tpl.routine_setup}</pre>
        </div>
      )}
    </section>
  );
}
