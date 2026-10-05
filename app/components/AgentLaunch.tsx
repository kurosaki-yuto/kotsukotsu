"use client";

import { useEffect, useRef, useState } from "react";
import { mcpConnectHint } from "../lib/hosts";
import { claudeCodeWebUrl } from "../lib/claudeLinks";

// ゴール詳細の「完了にする」の横に置く「AIで進める」プルダウン。
// このゴールの指示文を入れた状態で AI を開く (送信は本人が Enter)。
//   Claude: claude://code/new?q=...          (Claude Desktop の Code 画面。PC のみ)
//   Codex:  codex://threads/new?prompt=...   (Codex アプリ。PC のみ)
//   クラウド: https://claude.ai/code/new?q=...&repo=owner/repo
//            (Claude Code on the web。スマホでは Claude アプリが開く universal link。公式:
//             https://support.claude.com/en/articles/14898120-open-the-claude-mobile-app-with-a-link )
//   スマホ:   claude://code/new?q=...&repo=owner/repo (iOS・Android の Claude アプリ。同じ記事)
// claude.ai/code・chatgpt.com/codex は X-Frame-Options: SAMEORIGIN で埋め込めないため、別アプリ・別タブで開く形にしている。

// 細かい書き方 (完了の基準・現状の形式など) はこつこつ MCP の instructions に任せ、ここは着手の順番と止まる場所だけ書く。
// claude-cli の q は 5000 字まで。長くしすぎない。
function promptFor(id: string, name: string): string {
  return [
    `こつこつのタスク「${name}」を進めてください。`,
    `id: ${id}`,
    "",
    `1. こつこつのツールが読み (get_goal) と書き (add_subtask・update_goal・send_chat) の両方使えるか確かめる。どちらかが無ければ何もせず「こつこつが未接続です。${mcpConnectHint()}」とだけ返す`,
    "2. get_goal・list_subtasks・list_comments で、このタスクの完了の基準・現状・未完了の作業・最新のコメントを読む。親を最上位まで辿り、上位の完了の基準に寄与しないならそこで止めて理由を伝える",
    "3. 完了の基準が空か曖昧なら、分かる事実で書き直す。分からない点は質問して止まる",
    "4. 作業に要るファイルやコードの場所は、今いるフォルダと、タスクの現状・リソース・コメントに書かれたパスだけを見る。ホームフォルダ全体を探し回らず、書かれていなければ聞く",
    "5. 返り値に precedents (前に誰かがやった型) があれば先に読む。作業ステップを2〜5個 add_subtask で登録し、各ステップに手を付ける前にそのステップを start_task で進行中にする (進行中は一番下の小タスクにだけ付く)。1つ終わるごとに complete_subtask する。コミットするときはメッセージに `Task: ${id}` を入れる",
    "6. 結果はこのタスク自身に書く。update_goal で現状 (日付 / 済んだこと / ボール / 残り・詰まり) を書き直し、報告はこのタスクに send_chat する",
    "7. 外への送信・公開・金銭・契約・本番データの削除は、実行する前に必ず私の承認を取る",
    "8. 最後に、完了の基準の各項目を満たしたかどうかを1行ずつ報告して止まる",
  ].join("\n");
}

// デスクトップアプリを開くリンク。スマホでは開けないので PC 幅だけ出す
// スマホ用の短い指示文。iPhone の Claude アプリに渡すと、長い URL (5000文字超) では指示文が入ったり入らなかったりした
// (2026-09-29 黒崎)。細かい手順はこつこつ MCP の運用ルールとして接続した AI に毎回渡っているので、ここでは要点だけ書く
function shortPromptFor(id: string, name: string): string {
  const n = name.length > 60 ? name.slice(0, 60) + "…" : name;
  return `こつこつのタスク「${n}」(id: ${id}) を進めてください。こつこつの運用ルールどおりに、get_goal で完了の基準と現状を読み、作業ステップを add_subtask で登録し、手を付けるステップを start_task してから着手してください。外への送信・公開・金銭・契約・本番データの削除は、実行前に私の承認を取ってください。`;
}

const APPS = [
  { key: "codex", label: "Codex で進める", url: (q: string) => `codex://threads/new?prompt=${q}` },
  { key: "claude", label: "Claude Code で進める", url: (q: string) => `claude://code/new?q=${q}` },
] as const;

// クラウドの Claude Code で作業させるリポジトリ (owner/repo)。人によって違うので、その人の端末に覚えておく
const CLOUD_REPO_KEY = "kk:cloudRepo";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// 以前は web 用の claude.ai/code?prompt=&repositories= を使っていたが、iPhone ではこのリンクが Claude アプリに渡ると
// アプリの /code (一覧) に着いて指示文が落ちた (2026-09-29 黒崎)。モバイルアプリが受けるのは /code/new?q=&repo= の形だけで、
// web でも同じ形で指示文とリポジトリが入る (2026-10-02 確認) ので、スマホ・PC ともこの形にそろえる
function repoParam(repo: string): string {
  return REPO_RE.test(repo) ? `&repo=${encodeURIComponent(repo)}` : "";
}
// ブラウザで開く (アプリに渡さない)。アプリに渡すと指示文が落ちることがあるため、確実に入れたいときはこちら。
// ブラウザなら長い指示文も入るので、短縮版ではなく全文を渡す (lib/claudeLinks.ts)
function cloudUrl(text: string, repo: string): string {
  return claudeCodeWebUrl(text, repoParam(repo));
}
function mobileAppUrl(q: string, repo: string): string {
  return `claude://code/new?q=${q}` + repoParam(repo);
}

export default function AgentLaunch({ goalId, goalName }: { goalId: string; goalName: string }) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { setRepo(localStorage.getItem(CLOUD_REPO_KEY) ?? ""); } catch { /* private mode */ }
  }, []);
  const saveRepo = (v: string) => {
    setRepo(v);
    try { localStorage.setItem(CLOUD_REPO_KEY, v.trim()); } catch { /* private mode */ }
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const text = promptFor(goalId, goalName);
  const q = encodeURIComponent(text);
  const qShort = encodeURIComponent(shortPromptFor(goalId, goalName));
  // 押した時点で指示文もコピーしておく (スマホで Claude アプリに渡ったときに URL の中身が落ちても、貼れば始められる)
  const copy = () => { try { void navigator.clipboard.writeText(text); } catch { /* 非対応 */ } };
  // 「指示文をコピー」: 開かずにコピーだけする (Cursor や別の AI に貼るとき用)。押した結果をその場で見せてから閉じる
  const [copied, setCopied] = useState<"idle" | "ok" | "ng">("idle");
  const copyOnly = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      // clipboard API が使えない環境 (http・古いブラウザ) の代わり
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch { /* 非対応 */ }
    }
    setCopied(ok ? "ok" : "ng");
    if (ok) setTimeout(() => { setCopied("idle"); setOpen(false); }, 1200);
  };
  useEffect(() => { if (!open) setCopied("idle"); }, [open]);
  const repoOk = REPO_RE.test(repo.trim());
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12.5px] font-bold hover:bg-[var(--hover)] transition-colors"
        style={{ borderColor: "var(--border-strong)", color: "var(--foreground)", background: "var(--background)" }}
      >
        AIで進める
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 md:left-auto md:right-0 mt-1 z-20 w-[min(300px,calc(100vw-48px))] card py-1" style={{ boxShadow: "var(--shadow-pop)" }}>
          <button
            type="button"
            role="menuitem"
            onClick={() => { void copyOnly(); }}
            className="block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)] border-b"
            style={{ borderColor: "var(--border)" }}
          >
            {copied === "ok" ? "コピーしました" : "指示文をコピー"}
            <span className="block text-[11px] mt-0.5" style={{ color: copied === "ng" ? "var(--danger)" : "var(--muted)" }}>
              {copied === "ng" ? "コピーできませんでした。ブラウザの設定を確認してください" : "開かずにコピーだけします。好きな AI に貼って使えます"}
            </span>
          </button>
          {APPS.map((a) => (
            <a
              key={a.key}
              role="menuitem"
              href={a.url(q)}
              onClick={() => { copy(); setOpen(false); }}
              className="hidden md:block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]"
            >
              {a.label}
            </a>
          ))}
          {/* スマホの Claude アプリに指示文とリポジトリを直接渡す (公式のモバイル用リンク) */}
          <a
            role="menuitem"
            href={mobileAppUrl(qShort, repo.trim())}
            onClick={() => { copy(); setOpen(false); }}
            className="block md:hidden w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)]"
          >
            Claude アプリで進める
            <span className="block text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
              アプリに渡します。入っていなければ貼り付けてください (コピー済み)
            </span>
          </a>
          <a
            role="menuitem"
            href={cloudUrl(text, repo.trim())}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => { copy(); setOpen(false); }}
            className="block w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--hover)] md:border-t"
            style={{ borderColor: "var(--border)" }}
          >
            ブラウザの Claude Code で進める
            <span className="block text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
              アプリに渡さずブラウザで claude.ai/code を開きます。指示文が確実に入ります
            </span>
          </a>
          <label className="block px-4 pt-1 pb-2 text-[11px]" style={{ color: "var(--muted)" }}>
            Claude アプリ・クラウドで使うリポジトリ (owner/repo)
            <input
              value={repo}
              onChange={(e) => saveRepo(e.target.value)}
              placeholder="例: acme/ops"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1 block w-full rounded-md border px-2 py-1 text-[13px] text-[var(--foreground)] bg-transparent focus:outline-none"
              style={{ borderColor: repo && !repoOk ? "var(--danger)" : "var(--border-strong)" }}
            />
            <span className="block mt-1">
              {repo && !repoOk ? "owner/repo の形で入れてください" : "空なら開いた先で選びます。この端末に覚えます"}
            </span>
          </label>
          <div className="px-4 pt-1 pb-1.5 text-[11px] border-t" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>
            指示文を入れた状態で開きます (コピーもしています)
          </div>
        </div>
      )}
    </div>
  );
}
