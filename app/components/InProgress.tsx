"use client";

// タスクの「進行中」。status は active のまま、started_at が立っているものを進行中とみなす。
// 開いた・編集しただけでは進行中にしない (人は「開始」ボタン、AI は start_task で立てる)。

type Startable = { status: string; started_at?: string | null; started_by_name?: string | null; started_via?: string | null };

export function isInProgress(t: Startable): boolean {
  return t.status === "active" && !!t.started_at;
}

// 「黒崎優斗 (Claude Code)」。画面のボタンで始めたときは名前だけ
export function startedWho(t: Startable): string {
  const name = (t.started_by_name || "").trim() || "不明";
  const via = (t.started_via || "").trim();
  return via && via !== "app" ? `${name} (${via})` : name;
}

// 「9/29 8:05から」。今日なら時刻だけ
export function startedSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `今日 ${hm}から` : `${d.getMonth() + 1}/${d.getDate()} ${hm}から`;
}

/**
 * 進行中の印。detail=true で「誰が・いつから」を文字で出す (狭い行では印+名前だけ)。
 * wrapClass は出し分け用。行ではスマホで隠す (左のチェックの形で進行中は分かるので、名前の幅を優先する)
 */
export function InProgressBadge({ t, detail = false, wrapClass }: { t: Startable; detail?: boolean; wrapClass?: string }) {
  if (!isInProgress(t)) return null;
  const who = startedWho(t);
  const since = startedSince(t.started_at!);
  const badge = (
    <span className="doing-badge shrink-0" title={`進行中: ${who}・${since}`}>
      <span className="doing-dot" aria-hidden />
      進行中
      <span className={`doing-who ${detail ? "" : "hidden sm:inline"}`}>・{who}{detail ? `・${since}` : ""}</span>
    </span>
  );
  return wrapClass ? <span className={`shrink-0 min-w-0 ${wrapClass}`}>{badge}</span> : badge;
}

/**
 * 左の丸チェック。押すと完了/未完了が切り替わるのは今までどおりで、形で状態を見せる:
 * 未着手 = 空の丸 / 進行中 = 橙の輪と中の点 / 完了 = 緑に白チェック
 */
export function TaskCheck({ t, onToggle, square = false, idleBorder = "var(--border-strong)" }: {
  t: Startable; onToggle: (done: boolean) => void; square?: boolean; idleBorder?: string;
}) {
  const done = t.status === "done";
  const doing = isInProgress(t);
  const label = done ? "未完了に戻す" : "完了にする";
  const title = done ? label : doing ? `進行中 (${startedWho(t)}・${startedSince(t.started_at!)})。押すと完了にする` : label;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(!done); }}
      className={`w-5 h-5 shrink-0 ${square ? "rounded-md" : "rounded-full"} border flex items-center justify-center transition-colors`}
      style={
        done ? { background: "var(--done)", borderColor: "var(--done)" }
        : doing ? { borderColor: "var(--doing)", borderWidth: 2, background: "var(--doing-soft)" }
        : { borderColor: idleBorder }
      }
      aria-label={doing ? `進行中。${label}` : label}
      title={title}
    >
      {done && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      )}
      {doing && <span aria-hidden className={`w-2 h-2 ${square ? "rounded-sm" : "rounded-full"}`} style={{ background: "var(--doing)" }} />}
    </button>
  );
}

/**
 * 未着手のタスクに出す「開始」ボタン。完了済み・進行中には出さない。
 * wrapClass は出し分け用 (例: "hidden lg:inline-flex")。ボタン自身の display と競合しないよう外側の span に付ける
 */
export function StartButton({ t, onStart, className = "", wrapClass }: { t: Startable; onStart: () => void; className?: string; wrapClass?: string }) {
  if (t.status !== "active" || t.started_at) return null;
  const btn = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onStart(); }}
      className={`start-btn shrink-0 ${className}`}
      title="このタスクを進行中にする"
      aria-label="開始"
    >
      <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M4 3l9 5-9 5V3z" /></svg>
      開始
    </button>
  );
  return wrapClass ? <span className={`shrink-0 ${wrapClass}`}>{btn}</span> : btn;
}
