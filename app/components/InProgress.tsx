"use client";

// タスクの「進行中」。status は active のまま、started_at が立っているものを進行中とみなす。
// 開いた・編集しただけでは進行中にしない (人は「開始」ボタン、AI は start_task で立てる)。

// 開始は一番下のタスクに付き (started_*)、親の印は配下から集めた doing_* で出す。
// doing_* が無い取得元 (古い API) では自分の started_* を使う。
type Startable = {
  status: string;
  started_at?: string | null; started_by_name?: string | null; started_via?: string | null;
  doing_at?: string | null; doing_by_name?: string | null; doing_via?: string | null; doing_count?: number;
};

function doingOf(t: Startable) {
  if (t.doing_at) return { at: t.doing_at, name: t.doing_by_name, via: t.doing_via, count: t.doing_count ?? 1 };
  if (t.started_at) return { at: t.started_at, name: t.started_by_name, via: t.started_via, count: 1 };
  return null;
}

export function isInProgress(t: Startable): boolean {
  return t.status === "active" && !!doingOf(t);
}

// 「黒崎優斗 (Claude Code)」。画面のボタンで始めたときは名前だけ。配下の複数が進行中なら「ほか2件」
export function startedWho(t: Startable): string {
  const d = doingOf(t);
  const name = (d?.name || "").trim() || "不明";
  const via = (d?.via || "").trim();
  const more = d && d.count > 1 ? ` ほか${d.count - 1}件` : "";
  return (via && via !== "app" ? `${name} (${via})` : name) + more;
}
function startedAt(t: Startable): string {
  return doingOf(t)?.at ?? "";
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
  const since = startedSince(startedAt(t));
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
 * 左の丸チェック。形で状態を見せる: 未着手 = 空の丸 / 進行中 = 橙の輪と中の点 / 完了 = 緑に白チェック
 * 押したとき: 未着手 → 完了、完了 → 未完了に戻す、進行中 → 停止 (未着手に戻す)。
 * 進行中の丸を押して完了になると「止めたつもりが終わっていた」になるため (9/29 黒崎指摘)。進行中から終えるときは「完了にする」
 */
export function TaskCheck({ t, onToggle, onStop, square = false, idleBorder = "var(--border-strong)" }: {
  t: Startable; onToggle: (done: boolean) => void; onStop: () => void; square?: boolean; idleBorder?: string;
}) {
  const done = t.status === "done";
  const doing = isInProgress(t);
  const label = done ? "未完了に戻す" : doing ? "停止 (未着手に戻す)" : "完了にする";
  const title = doing ? `進行中 (${startedWho(t)}・${startedSince(startedAt(t))})。押すと停止して未着手に戻す` : label;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (doing) onStop(); else onToggle(!done); }}
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
 * 「開始」と「停止」を同じ場所で切り替えるボタン。未着手なら開始、進行中なら停止 (未着手に戻す)。完了済みには出さない。
 * wrapClass は出し分け用 (例: "hidden lg:inline-flex")。ボタン自身の display と競合しないよう外側の span に付ける
 */
export function StartButton({ t, onToggle, className = "", wrapClass }: { t: Startable; onToggle: (started: boolean) => void; className?: string; wrapClass?: string }) {
  if (t.status !== "active") return null;
  const doing = isInProgress(t);
  const btn = (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(!doing); }}
      className={`start-btn shrink-0 ${doing ? "is-stop" : ""} ${className}`}
      title={doing ? "進行中をやめて未着手に戻す (配下もまとめて)" : "このタスクを進行中にする (配下があれば、配下の未完了をまとめて開始)"}
      aria-label={doing ? "停止" : "開始"}
    >
      {doing
        ? <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /></svg>
        : <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M4 3l9 5-9 5V3z" /></svg>}
      {doing ? "停止" : "開始"}
    </button>
  );
  return wrapClass ? <span className={`shrink-0 ${wrapClass}`}>{btn}</span> : btn;
}
