"use client";

// 設定 > APIキー / 連携ガイド のタブ。settings/page.tsx から切り出し。
import { useEffect, useRef, useState } from "react";
import { MCP_HOST, NODE_RUNTIME } from "../lib/hosts";
import IntegrationGuide from "./IntegrationGuide";


/* =========================================================
   APIキー
   ========================================================= */
export const MCP_WORKERS_DEV = `https://${MCP_HOST}/mcp`;

// キー入りURLの接続先。独自ドメインから開いていれば mcp.kotukotu.app、pages.dev の入口から
// 開いていれば同じアドレスの /mcp を渡す (Pages が service binding で kotsukotsu-mcp へ渡す)。
// それ以外は workers.dev 直。
export function mcpEndpoint(): string {
  if (typeof window === "undefined") return MCP_WORKERS_DEV;
  const { host, origin } = window.location;
  if (NODE_RUNTIME) return `${origin}/mcp`; // Docker 版は同じサーバーが /mcp を受ける
  if (host === "kotukotu.app" || host.endsWith(".kotukotu.app")) return MCP_SHARED;
  return host.endsWith(".pages.dev") ? `${origin}/mcp` : MCP_WORKERS_DEV;
}

// 全員共通の接続先。キーは入っていない。claude.ai / Claude Code はここに繋ぐと
// (独自ドメインにしているのは、claude.ai のコネクタ一覧のアイコンを こつこつ にするため。
//  pages.dev のままだと Cloudflare のロゴになる。pages-proxy/public/_worker.js 参照)
// サインイン (OAuth) に進み、こつこつにログインしている本人として繋がる
// (mcp-worker/src/oauth.ts)。SaaS のコネクタと同じく、URL は全員同じでよい。
export const MCP_SHARED = "https://mcp.kotukotu.app/mcp";

// キー無しの共通URL (OAuth でログイン) が使えるのは kotukotu.app だけ。自分でデプロイした
// こつこつ (workers.dev) は本体と MCP が別ホストでログイン cookie が届かないので、
// キー入りURLを案内する。
export function sharedLoginAvailable(): boolean {
  if (typeof window === "undefined") return true;
  const { host } = window.location;
  return host === "kotukotu.app" || host.endsWith(".kotukotu.app");
}

// A labeled, copyable code/config block (used by the per-client connect guides).
export function Snippet({ label, code, note }: { label: string; code: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  function copy() {
    try { navigator.clipboard?.writeText(code); } catch { /* clipboard unavailable */ }
    setCopied(true);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="rounded-[10px] border p-3" style={{ borderColor: "var(--border)", background: "#fff" }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-bold" style={{ color: "var(--foreground)" }}>{label}</span>
        <button type="button" className="chip flex-none" onClick={copy}>{copied ? "コピー済" : "コピー"}</button>
      </div>
      {/* 横スクロールさせず折り返して全文を見せる。長い URL・キーも途中で折る (コピーは元の1行のまま) */}
      <pre className="rounded-[8px] px-3 py-2.5 font-mono text-[12px] leading-relaxed" style={{ background: "#0f1420", color: "#e6e9ef", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{code}</pre>
      {note && <div className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{note}</div>}
    </div>
  );
}

// 連携ガイド (IntegrationGuide.tsx) に、APIキータブと同じ接続先を渡す。
// 接続先の出し分け (当社ホスト版 / 自社専用版) はこのファイルに集めてある (公開版の書き出しの検査対象)。
export function GuideTab({ token }: { token: string | null }) {
  const [official, setOfficial] = useState(true);
  const [endpoint, setEndpoint] = useState(MCP_WORKERS_DEV);
  useEffect(() => {
    setOfficial(sharedLoginAvailable());
    setEndpoint(mcpEndpoint());
  }, []);
  const keyUrl = token ? `${endpoint}/${token}` : "";
  return <IntegrationGuide connectUrl={official ? MCP_SHARED : keyUrl} keyUrl={keyUrl} official={official} />;
}

export function ApiKeyTab({ token, onRegen }: { token: string | null; onRegen: () => Promise<void>; admin: boolean }) {
  const [sharedCopied, setSharedCopied] = useState(false);
  const [sharedLogin, setSharedLogin] = useState(true);
  useEffect(() => setSharedLogin(sharedLoginAvailable()), []);
  const sharedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (sharedTimer.current) clearTimeout(sharedTimer.current);
    };
  }, []);

  const hasToken = typeof token === "string" && token.length > 0;

  // 接続用フルURL（キーをクエリパラメータとして含む）。これ1本を貼るだけで接続できる。
  // トークンはパス埋め込み (claude.ai のカスタムコネクタはクエリ文字列を
  // 落とすことがあるため)。旧 ?key= 形式も引き続き有効。
  const connectUrl = hasToken ? `${mcpEndpoint()}/${token!}` : "";
  // 見出しの「接続用URL」。自分でデプロイした環境ではキー入りURLになる。
  const headlineUrl = sharedLogin ? MCP_SHARED : connectUrl;

  function handleCopyShared() {
    try {
      if (!headlineUrl) return;
      navigator.clipboard?.writeText(headlineUrl);
    } catch {
      /* clipboard unavailable */
    }
    setSharedCopied(true);
    if (sharedTimer.current) clearTimeout(sharedTimer.current);
    sharedTimer.current = setTimeout(() => setSharedCopied(false), 1500);
  }

  async function handleRegen() {
    if (!window.confirm("再生成すると今のキー入りURLは無効になります。続行?")) return;
    await onRegen();
  }

  return (
    <section className="card max-w-[680px] p-4 md:p-6">
      <h2 className="mb-1.5 text-base font-bold">AIと繋ぐ（MCP）</h2>
      <p className="mb-6 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Claudeを繋ぐと、AIがあなたのゴールやタスクを直接読み書きできるようになります。
        繋がるのはログインしたあなた本人として、あなたが見られる範囲だけです。
      </p>

      {/* ---------- explainer video: watch before following the steps below ---------- */}
      <div className="mb-6 rounded-[12px] border overflow-hidden" style={{ borderColor: "var(--border)" }}>
        <div className="px-5 pt-4 pb-3 text-[14px] font-bold" style={{ color: "var(--foreground)" }}>
          使い方動画（AI接続）
        </div>
        <div style={{ position: "relative", paddingBottom: "56.25%", height: 0 }}>
          <iframe
            src="https://www.loom.com/embed/9589122229694a0db9c4f40acc4ad86e"
            title="こつこつ AI接続の使い方"
            allow="fullscreen"
            allowFullScreen
            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" }}
          />
        </div>
      </div>

      {/* ---------- headline: shared connect URL (sign in with your own account) ---------- */}
      <div
        className="mb-6 rounded-[12px] border p-5"
        style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}
      >
        <div className="mb-1.5 text-[14px] font-bold" style={{ color: "var(--foreground)" }}>
          {sharedLogin ? "接続用URL（全員共通）" : "接続用URL（あなた専用）"}
        </div>
        <div className="mb-3.5 text-[12px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
          {sharedLogin
            ? "キーは入っていません。誰が使っても同じURLで、繋ぐときにこつこつのログインで本人を確認します。"
            : "あなたのキーが入っています。人に共有しないでください。漏れたら下の「再生成」で無効化できます。"}
        </div>

        <div
          className="mb-3 flex items-center gap-2 rounded-[10px] border px-3.5 py-2.5"
          style={{ borderColor: "var(--border)", background: "#fff" }}
        >
          <div className="min-w-0 flex-1 select-all break-all font-mono text-[13px]" style={{ color: "var(--foreground)" }}>
            {headlineUrl}
          </div>
        </div>

        <button type="button" className="btn-dark w-full" onClick={handleCopyShared}>
          {sharedCopied ? "コピー済" : "コピー"}
        </button>

        <ol className="mt-4 flex flex-col gap-2">
          {[
            <>① 上の「接続用URL」をコピー</>,
            <>
              ② Claudeの<strong>「カスタムコネクタを追加」</strong>を開き、
              名前に <strong>こつこつ</strong>、
              <strong>「リモートMCPサーバーURL」</strong>にペーストして<strong>「追加」</strong>
              （OAuth欄は空のままでOK）
            </>,
            sharedLogin ? (
              <>
                ③ <strong>「連携させる」</strong>を押すと、こつこつのログイン画面が開きます。
                ログインすれば接続完了（すでにログイン中なら自動で完了）
              </>
            ) : (
              <>③ <strong>「連携させる」</strong>を押せば接続完了</>
            ),
          ].map((body, i) => (
            <li
              key={i}
              className="text-[13px] leading-relaxed"
              style={{ color: "var(--foreground-soft)" }}
            >
              {body}
            </li>
          ))}
        </ol>

        <div className="mt-3.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          繋いだのにツールが見つからないときは、名前を <strong>kotsukotsu</strong>（半角英数）にして追加し直してください。
        </div>
      </div>

      {/* ---------- per-client connect guides (Codex / Claude Code / others) ---------- */}
      {hasToken && (
        <div className="mb-6 rounded-[12px] border p-5" style={{ borderColor: "var(--border)", background: "#fafafb" }}>
          <div className="mb-1.5 text-[14px] font-bold" style={{ color: "var(--foreground)" }}>
            他のAIツールと繋ぐ（Claude Code / Codex など）
          </div>
          <div className="mb-4 text-[12px] leading-relaxed" style={{ color: "var(--foreground-soft)" }}>
            {sharedLogin
              ? "Claude Code は共通URLのまま、初回にブラウザでログインするだけで繋がります。ログイン画面を出せないツール（Codex など）は、あなた専用のキー入りURLを使います。"
              : "どのツールも、あなた専用のキー入りURLで繋ぎます。"}
          </div>
          <div className="flex flex-col gap-3">
            <Snippet
              label="Claude Code（ターミナル）"
              code={`claude mcp add --transport http kotsukotsu ${headlineUrl}`}
              note={sharedLogin
                ? "実行後、Claude Code で /mcp → kotsukotsu → Authenticate を選ぶとブラウザでログイン画面が開きます。"
                : "キー入りURLなので、実行すればそのまま繋がります。コマンドは人に共有しないでください。"}
            />
            <Snippet
              label="あなた専用のキー入りURL（ログイン画面を出せないツール用）"
              code={connectUrl}
              note="このURLにはキーが含まれます。人に共有しないでください。"
            />
            <Snippet
              label="Codex CLI（~/.codex/config.toml に追記）"
              code={`[mcp_servers.kotsukotsu]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${connectUrl}"]`}
              note="保存後 codex を再起動。npx が mcp-remote を自動取得し、リモートMCPに橋渡しします。"
            />
            <Snippet
              label="その他（Cursor / Windsurf / 汎用 stdio クライアント）"
              code={`npx -y mcp-remote "${connectUrl}"`}
              note="各ツールのMCP設定で、この1行を command として登録。HTTPのリモートMCPをstdioに変換します。"
            />
          </div>
          <div className="mt-3.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
            キー入りURLとそれを使うコマンドは共有しないでください。漏れたら下の「再生成」で一括無効化できます。
          </div>
        </div>
      )}

      {/* ---------- regenerate (invalidates the connect URL) ---------- */}
      <div className="mb-6">
        <button type="button" className="chip" onClick={handleRegen}>
          キー入りURLを再生成（無効化）
        </button>
        <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          再生成すると今のキー入りURLは無効になります。共通URLで繋いでいる場合も、Claude側で再接続が必要になることがあります。
        </div>
      </div>

      {/* ---------- capabilities ---------- */}
      <div
        className="rounded-[10px] border p-4"
        style={{ borderColor: "var(--border)", background: "#fafafb" }}
      >
        <div className="mb-2.5 text-[13px] font-bold" style={{ color: "var(--foreground)" }}>
          MCPで操作できること
        </div>
        <ul className="flex flex-col gap-1.5">
          {[
            "ゴール／タスクの一覧・作成・更新・完了",
            "担当者のアサイン（割り当て）",
            "コメントの追加",
            "通知の作成",
          ].map((cap) => (
            <li
              key={cap}
              className="flex items-start gap-2 text-[13px] leading-relaxed"
              style={{ color: "var(--foreground-soft)" }}
            >
              <span className="flex-none pt-0.5" style={{ color: "var(--accent)" }}>
                •
              </span>
              <span>{cap}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
