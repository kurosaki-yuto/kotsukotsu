/**
 * タスクに入るとき (get_goal / start_task / complete_subtask) に渡す「この仕事の型」。
 * docs/plans/2026-10-14_型をナレッジの入口にする.md の 4 章。
 *
 * 型が無くても仕事は振れる。型は必要なときに取りに行く (黒崎判断 2026-10-14)。
 * 選び方: そのタスクか祖先が型から作られていればその型。無ければ、名前と完了の基準が近い型を 1 本。
 * 型の本文は持たない。返すのは 資料 (種類・URL・何のために見るか)・注意点・結んだ前例 だけ。
 */
import { parseTemplateRow, kataExportPath, kataExportStale, kataExportUrl, type KataExportTarget, type Template, type TemplateRow } from "../../app/lib/server/templateCore";
import { EMBED_MODEL, MIN_SCORE, MIN_SIMILARITY, cosine, embed, grams, overlapScore, packVec, unpackVec } from "./playbooks";

export type KataPrecedent = { playbook_id: string; title: string; by: string; steps: string; pitfalls?: string; updated_at: string };

export type Kata = {
  template_id: string;
  name: string;
  /** from_template = このタスクか祖先が型から作られた / similar = 名前が近い型を選んだ */
  how: "from_template" | "similar";
  /** 意味の近さ (0〜1)。Workers AI で選んだときだけ付く */
  similarity?: number;
  purpose: string | null;
  resources: Template["resources"];
  cautions: string[];
  precedents: KataPrecedent[];
  export_url: string | null;
  /** 外の置き場所 (GitHub) の Markdown が型より古いとき、書き直す先 */
  export_stale?: { url: string; path: string; repo: string };
};

// 型の数は前例より少ない前提。新しい順に一定数だけ見る (見ている範囲は ORDER BY で決定的)。
const SCAN_LIMIT = 200;

/** そのタスクか一番近い祖先の template_id。無ければ null。 */
export async function templateIdForGoal(db: D1Database, wsId: string, goalId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `WITH RECURSIVE up(id, parent, tpl, depth) AS (
         SELECT id, parent_goal_id, template_id, 0 FROM projects WHERE id = ? AND workspace_id = ?
         UNION ALL
         SELECT p.id, p.parent_goal_id, p.template_id, up.depth + 1 FROM up CROSS JOIN projects p ON p.id = up.parent
          WHERE p.workspace_id = ? AND up.tpl IS NULL AND up.depth < 20
       )
       SELECT tpl FROM up WHERE tpl IS NOT NULL ORDER BY depth LIMIT 1`
    )
    .bind(goalId, wsId, wsId)
    .first<{ tpl: string }>();
  return row?.tpl ?? null;
}

function templateText(t: Pick<Template, "name" | "purpose">): string {
  return `${t.name}\n${(t.purpose ?? "").slice(0, 300)}`;
}

/** text に一番近い型を 1 本。前例と同じしきい値 (意味の近さ 0.56 / 言葉の重なり 2.7)。 */
export async function similarTemplate(
  db: D1Database, wsId: string, text: string, ai?: Ai
): Promise<{ row: TemplateRow; score: number; semantic: boolean } | null> {
  if (text.trim().length < 4) return null;
  const res = await db
    .prepare("SELECT * FROM templates WHERE workspace_id = ? AND archived_at IS NULL ORDER BY updated_at DESC, id LIMIT ?")
    .bind(wsId, SCAN_LIMIT)
    .all<TemplateRow>();
  const rows = res.results ?? [];
  if (!rows.length) return null;
  let scored: { row: TemplateRow; score: number }[];
  if (ai) {
    const missing = rows.filter((r) => !r.embedding || r.embedding_model !== EMBED_MODEL);
    if (missing.length) {
      const vecs = await embed(ai, missing.map(templateText));
      missing.forEach((r, i) => { r.embedding = packVec(vecs[i]); r.embedding_model = EMBED_MODEL; });
      await db.batch(missing.map((r) =>
        db.prepare("UPDATE templates SET embedding = ?, embedding_model = ? WHERE id = ? AND workspace_id = ?").bind(r.embedding, EMBED_MODEL, r.id, wsId)
      ));
    }
    const [qv] = await embed(ai, [text.slice(0, 1000)]);
    scored = rows.map((row) => ({ row, score: cosine(qv, unpackVec(row.embedding!)) })).filter((x) => x.score >= MIN_SIMILARITY);
  } else {
    const q = grams(text);
    const docs = rows.map((r) => grams(templateText(r)));
    const df = new Map<string, number>();
    for (const d of docs) for (const g of d) df.set(g, (df.get(g) ?? 0) + 1);
    const idf = (g: string) => Math.log(1 + docs.length / (df.get(g) ?? 1)) / Math.log(1 + docs.length);
    scored = rows.map((row, i) => ({ row, score: overlapScore(q, docs[i], idf) })).filter((x) => x.score >= MIN_SCORE);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ? { ...scored[0], semantic: !!ai } : null;
}

/** 型に結んだ前例 (新しい順)。 */
export async function playbooksForTemplate(db: D1Database, wsId: string, templateId: string, limit = 10): Promise<KataPrecedent[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, author_name, steps, pitfalls, updated_at FROM playbooks
        WHERE workspace_id = ? AND template_id = ? ORDER BY updated_at DESC, id LIMIT ?`
    )
    .bind(wsId, templateId, limit)
    .all<{ id: string; title: string; author_name: string | null; steps: string; pitfalls: string | null; updated_at: string }>();
  return (results ?? []).map((r) => ({
    playbook_id: r.id, title: r.title, by: r.author_name || "記録なし", steps: r.steps,
    ...(r.pitfalls?.trim() ? { pitfalls: r.pitfalls } : {}), updated_at: r.updated_at,
  }));
}

export async function kataForGoal(
  db: D1Database, wsId: string, goal: { id: string; name?: string | null; completion_criteria?: string | null }, ai?: Ai,
  exportTarget?: KataExportTarget | null
): Promise<Kata | null> {
  let row: TemplateRow | null = null;
  let how: Kata["how"] = "from_template";
  let similarity: number | undefined;
  const tplId = await templateIdForGoal(db, wsId, goal.id);
  if (tplId) {
    row = await db.prepare("SELECT * FROM templates WHERE id = ? AND workspace_id = ? AND archived_at IS NULL").bind(tplId, wsId).first<TemplateRow>();
  }
  if (!row) {
    const hit = await similarTemplate(db, wsId, `${goal.name ?? ""}\n${goal.completion_criteria ?? ""}`, ai);
    if (!hit) return null;
    row = hit.row;
    how = "similar";
    // 意味の近さ (0〜1) のときだけ出す。言葉の重なりの点数は尺度が違うので出さない
    if (hit.semantic) similarity = Math.round(hit.score * 100) / 100;
  }
  const t = parseTemplateRow(row);
  return {
    template_id: t.id,
    name: t.name,
    how,
    ...(similarity !== undefined ? { similarity } : {}),
    purpose: t.purpose,
    resources: t.resources,
    cautions: t.cautions.map((c) => c.text),
    precedents: await playbooksForTemplate(db, wsId, t.id),
    export_url: t.export_url ?? null,
    ...(exportTarget && kataExportStale(t)
      ? (() => { const path = kataExportPath(exportTarget, t); return { export_stale: { url: kataExportUrl(exportTarget, path), path, repo: exportTarget.repo } }; })()
      : {}),
  };
}

/** 返り値に添える説明。型をどう扱うかを AI に毎回伝える (前例より強い書き方)。 */
export function kataNote(k: Kata, at: "get" | "start" | "complete"): string {
  const head = k.how === "from_template"
    ? `この仕事は型「${k.name}」から作られている。この型で進める。`
    : `この仕事に近い型「${k.name}」がある。合っていればこの型で進め、合わなければ無視してよい (無視した理由を現状に一言書く)。`;
  const ex = k.export_stale
    ? `型の外の置き場所 (${k.export_stale.url}) が型より古い。手が空いたら get_template_markdown (template: ${k.template_id}) で中身を取り、本人の GitHub ログインで ${k.export_stale.repo} の ${k.export_stale.path} に書いて、record_template_export で記録する (書けない環境なら飛ばす)。`
    : "";
  if (at === "complete") {
    return (
      `${head}完了にする前に、型の注意点 (kata.cautions) に1つずつ○×を付ける。× があれば直してから完了にし、` +
      "直した中身は send_chat でこのタスクに残す。差し戻しや × から分かった新しい注意点は propose_template_change で型に足す (型が育つ)。" + ex
    );
  }
  return (
    `${head}手を動かす前に kata.resources を開いて読む (why が何のために見るか。url が r2: で始まるものはこつこつに上げたファイルで、get_file で読む)。kata.cautions は必ず守る。` +
    "kata.precedents は以前この型でやったときの手順。" +
    "途中で人から差し戻し・訂正が入ったら、その内容を propose_template_change で型の注意点に足す。" + ex
  );
}
