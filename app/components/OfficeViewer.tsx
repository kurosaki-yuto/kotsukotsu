"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFileBytes, officeKindOf, type OfficeKind } from "../lib/addness";

// Word・Excel・PowerPoint をブラウザの中だけで描く (ファイルを外のサービスに送らない)。
// 描いた中身は sandbox の iframe (スクリプトが動かない) に入れる。ファイルに javascript: のリンクや
// スクリプトが混ざっていても、こつこつの cookie・画面には触れない。描くのはこのページのスクリプトで、
// iframe の DOM に直接書き込む (allow-same-origin はそのため。allow-scripts は付けない)。
// 文書の中のリンクは新しいタブで開く (allow-popups-to-escape-sandbox で、開いた先は普通のページになる)。

const FRAME_DOC = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><base target="_blank"><style>
html,body{margin:0;background:#f3f4f6;color:#1f2328;font-family:"Noto Sans JP","Hiragino Sans",system-ui,sans-serif}
.docx-wrapper{background:#f3f4f6!important;padding:16px!important;align-items:safe center!important}
.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(0,0,0,.15)!important;margin-bottom:16px!important}
.sheet{padding:8px}
.sheet table{border-collapse:collapse;background:#fff;font-size:13px}
.sheet td,.sheet th{border:1px solid #d0d7de;padding:3px 8px;white-space:pre;vertical-align:top}
.note{padding:12px 16px;font-size:13px;color:#57606a}
.slides{padding:16px;display:flex;justify-content:safe center}
.pptx-preview-wrapper{height:auto!important;overflow:visible!important;background:transparent!important}
.pptx-preview-slide-wrapper{box-shadow:0 1px 4px rgba(0,0,0,.15);margin-bottom:16px!important}
</style></head><body data-viewer="1"></body></html>`;

// 大きい表をそのまま描くと画面が固まるので、先頭だけ描いて残りはダウンロードしてもらう
const SHEET_MAX_ROWS = 2000;
const SHEET_MAX_COLS = 100;
const SLIDE_WIDTH = 960;

type Sheet = { name: string; html: string; truncated: boolean };

// CSV は文字コードが分からないので、UTF-8 で読めなければ Shift_JIS (Excel の既定) として読む
function decodeCsv(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

async function readSheets(buf: ArrayBuffer, isCsv: boolean): Promise<Sheet[]> {
  const XLSX = await import("xlsx");
  const wb = isCsv ? XLSX.read(decodeCsv(buf), { type: "string", raw: true }) : XLSX.read(buf, { type: "array", cellDates: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws?.["!ref"];
    // 範囲 (!ref) だけあって値の入ったセルが無いシートもある (Excel で作っただけのシートは A1 になる)
    if (!ws || !ref || !Object.keys(ws).some((k) => !k.startsWith("!"))) return { name, html: `<p class="note">このシートは空です</p>`, truncated: false };
    const range = XLSX.utils.decode_range(ref);
    const truncated = range.e.r - range.s.r + 1 > SHEET_MAX_ROWS || range.e.c - range.s.c + 1 > SHEET_MAX_COLS;
    if (truncated) {
      ws["!ref"] = XLSX.utils.encode_range({
        s: range.s,
        e: { r: Math.min(range.e.r, range.s.r + SHEET_MAX_ROWS - 1), c: Math.min(range.e.c, range.s.c + SHEET_MAX_COLS - 1) },
      });
    }
    const html = XLSX.utils.sheet_to_html(ws, { header: "", footer: "" });
    ws["!ref"] = ref;
    return { name, html, truncated };
  });
}

// SheetJS の HTML は値をエスケープ済み。万一何か混ざっても iframe の中なのでスクリプトは動かない
function showSheet(doc: Document, s: Sheet) {
  doc.body.innerHTML =
    (s.truncated ? `<p class="note">大きい表なので先頭の ${SHEET_MAX_ROWS} 行・${SHEET_MAX_COLS} 列だけ出しています。全部はダウンロードして見てください。</p>` : "") +
    `<div class="sheet">${s.html}</div>`;
  doc.documentElement.scrollTop = 0;
}

/** iframe の文書に描く。表はシートの一覧を返す (描くのはシートを選んだとき) */
async function renderInto(doc: Document, kind: OfficeKind, buf: ArrayBuffer, fileKey: string): Promise<Sheet[] | null> {
  doc.body.replaceChildren();
  if (kind === "docx") {
    const { renderAsync } = await import("docx-preview");
    // docx-preview は渡した置き場所の中身を消してから書くので、head (こちらのスタイル) ではなく専用の箱を渡す
    const styleBox = doc.createElement("div");
    const pages = doc.createElement("div");
    // append() は Workers の型 (HTMLRewriter の Element) と混ざって型が合わないので appendChild を使う
    doc.body.appendChild(styleBox);
    doc.body.appendChild(pages);
    await renderAsync(buf, pages, styleBox, {
      inWrapper: true,
      ignoreLastRenderedPageBreak: true,
      ignoreFonts: true, // 埋め込みフォントは blob: で読むので CSP に止められる。無くても本文は読める
      useBase64URL: true, // 画像は data: で埋める (blob: の後始末が要らない)
      renderComments: false,
    });
    return null;
  }
  if (kind === "pptx") {
    const { init } = await import("pptx-preview");
    const host = doc.createElement("div");
    host.className = "slides";
    const inner = doc.createElement("div");
    host.appendChild(inner);
    doc.body.appendChild(host);
    await init(inner, { width: SLIDE_WIDTH, height: Math.round((SLIDE_WIDTH * 9) / 16), mode: "list" }).preview(buf);
    return null;
  }
  return readSheets(buf, /\.csv$/i.test(fileKey));
}

export function OfficeViewer({ fileKey, className }: { fileKey: string; className?: string }) {
  const kind = officeKindOf(fileKey);
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameDoc, setFrameDoc] = useState<Document | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);

  // 文書・スライドが枠より広いときは、枠の幅に合わせて縮める (スマホでも1ページ分が見える)
  const fit = useCallback(() => {
    const el = frame.current;
    const doc = el?.contentDocument;
    if (!el || !doc?.body || kind === "sheet") return;
    doc.body.style.zoom = "1";
    const w = doc.documentElement.scrollWidth;
    const avail = el.clientWidth;
    if (w > avail && avail > 0) doc.body.style.zoom = String(avail / w);
  }, [kind]);

  // iframe は最初 about:blank (読み込み済み扱い) で、そのあと srcDoc に入れ替わる。about:blank に描くと
  // 入れ替わりで消えるので、srcDoc の目印 (data-viewer) が付いた文書になってから描く。入れ替わったら描き直す
  const takeDoc = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (d?.body?.dataset.viewer === "1") setFrameDoc(d);
  }, []);
  useEffect(() => { takeDoc(); }, [takeDoc]);

  useEffect(() => {
    if (!frameDoc || !kind) return;
    let alive = true;
    setStatus("loading");
    (async () => {
      const buf = await fetchFileBytes(fileKey);
      if (!alive) return;
      const list = await renderInto(frameDoc, kind, buf, fileKey);
      if (!alive) return;
      if (list) {
        setSheets(list);
        setSheetIdx(0);
      }
      fit();
      setStatus("ready");
    })().catch((e) => {
      if (!alive) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    });
    return () => { alive = false; };
  }, [frameDoc, kind, fileKey, fit]);

  // 表はシートを切り替えるたびに描き直す
  useEffect(() => {
    if (kind !== "sheet" || !sheets.length || !frameDoc) return;
    const s = sheets[sheetIdx];
    if (s) showSheet(frameDoc, s);
  }, [kind, sheets, sheetIdx, frameDoc]);

  useEffect(() => {
    const el = frame.current;
    if (!el || kind === "sheet") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, kind]);

  if (!kind) {
    return <div className="text-[13px] text-[var(--muted-soft)]">このファイル形式は画面で開けません。ダウンロードして確認してください。</div>;
  }
  return (
    <div className={`flex flex-col min-h-0 ${className ?? ""}`}>
      {kind === "sheet" && sheets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto pb-2 shrink-0" role="tablist" aria-label="シート">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === sheetIdx}
              onClick={() => setSheetIdx(i)}
              className="chip whitespace-nowrap"
              style={i === sheetIdx ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {status === "loading" && <div className="text-[13px] text-[var(--muted-soft)] pb-2 shrink-0">読み込み中…</div>}
      {status === "error" && (
        <div className="text-[13px] pb-2 shrink-0" style={{ color: "var(--danger)" }}>
          画面で開けませんでした ({error || "不明なエラー"})。ダウンロードして確認してください。
        </div>
      )}
      <iframe
        ref={frame}
        title="ファイルの中身"
        srcDoc={FRAME_DOC}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        onLoad={takeDoc}
        className="w-full flex-1 min-h-0 rounded-lg border bg-white"
        style={{ borderColor: "var(--border)" }}
      />
    </div>
  );
}
