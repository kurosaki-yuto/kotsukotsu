/**
 * 型 (playbook) — 誰かが終えたタスクから抜き出した「何をするときに・どの順で・何に気をつけたか」。
 *
 * メンバーの AI が get_goal / add_subtask を呼ぶと、そのタスクに似た型が返り値に自動で付く。
 * 本人が頼まなくても「前にこの人はこうやった」が AI に入る、というのが目的。
 *
 * 型は全メンバーに見せる (黒崎判断 2026-09-28)。だから中身に顧客名・金額・個人情報を入れない。
 * 元タスクの名前は型に保存せず、見せるときに source_goal_id から引いて、呼び手が見える範囲に
 * あるときだけ出す (canSee)。見えない人には「誰がどんな型でやったか」だけが届く。
 */

export type PlaybookCommit = { repo: string; sha: string; message?: string };

type PlaybookRow = {
  id: string;
  source_goal_id: string | null;
  author_name: string | null;
  title: string;
  keywords: string | null;
  steps: string;
  pitfalls: string | null;
  commits: string | null;
  updated_at: string;
};

export type Precedent = {
  playbook_id: string;
  title: string;
  by: string;
  steps: string;
  pitfalls?: string;
  commits?: PlaybookCommit[];
  source_task?: { id: string; name: string };
  /** 意味の近さ (0〜1)。Workers AI で選んだときだけ付く */
  similarity?: number;
  updated_at: string;
};

// 似ているかの判定は文字の2-gram の重なり。日本語は分かち書きが無いので単語で割らない。
// ひらがなだけの2-gram (「する」「ている」) はどの文にも出るので捨てる。
function grams(text: string): Set<string> {
  const s = text
    .toLowerCase()
    .replace(/この状態になったら完了。?/g, "")
    .replace(/[\s□・、。，．,.:：;；!！?？()（）「」『』\[\]【】\/\\\-—_~〜|"'`#*>]+/g, " ");
  const out = new Set<string>();
  // 英数字は単語のまま、それ以外 (日本語) は2-gram。「Firebase連携」のような混在も英単語を取り出す。
  for (const part of s.match(/[a-z0-9]+|[^a-z0-9 ]+/g) ?? []) {
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length >= 2) out.add(part);
      continue;
    }
    for (let i = 0; i < part.length - 1; i++) {
      const g = part.slice(i, i + 2);
      if (/^[ぁ-ゟ]{2}$/.test(g)) continue;
      out.add(g);
    }
  }
  return out;
}

// 重なった2-gram を、型の中での珍しさ (idf) で重み付けして足す。「導入」「確認」のようにどの型にも
// 出る語は軽く、「LINE」「CSV」「採用」のような語は重くなる。長い文を投げても薄まらない。
function overlapScore(q: Set<string>, d: Set<string>, idf: (g: string) => number): number {
  let w = 0;
  for (const g of q) if (d.has(g)) w += idf(g);
  return w;
}

// 型の数が増えても毎回全件は読まない。新しい順に一定数だけ見る (見ている範囲は ORDER BY で決定的)。
const SCAN_LIMIT = 400;
// idf は log(1+N/df) を log(1+N) で割ったもの (0〜1)。型の数が増えても尺度が変わらないようにしている。
// 実データ (型59件) で、同じ種類の仕事は 2.8 以上、関係の薄いものは 2.6 以下に出た (2026-09-28)。
// AI バインディングが無い環境 (自社専用版で Workers AI を使わない場合) だけで使う。
const MIN_SCORE = 2.7;

// ---- 意味での検索 (Workers AI) ----
// 言葉の重なりだけでは「確認」「洗い出し」のような語で関係ない型が付いたため、埋め込みで選ぶ (2026-09-28)。
export const EMBED_MODEL = "@cf/baai/bge-m3";
// 型59件と14の問い合わせで測った値 (2026-09-28)。正解は 0.56〜0.70、関係ない型はほぼ 0.55 以下。
// ただ正解の隣に 0.58〜0.61 の外れが並ぶことがあるため、1位から 0.04 以内のものだけ残す。
const MIN_SIMILARITY = 0.56;
const NEAR_BEST = 0.04;
const EMBED_BATCH = 50;

/** 型を埋め込むときの文。題名と語を主に、手順は頭だけ (長すぎると題名の意味が薄まる)。 */
function playbookText(r: { title: string; keywords: string | null; steps: string }): string {
  return `${r.title}\n${(r.keywords ?? "").replace(/\n/g, " ")}\n${r.steps.slice(0, 300)}`;
}

async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  const out = (await ai.run(EMBED_MODEL as never, { text: texts } as never)) as { data?: number[][] };
  if (!out?.data || out.data.length !== texts.length) throw new Error("埋め込みの取得に失敗しました");
  return out.data;
}

// 1024 次元の float を JSON で持つと、型が増えたとき毎回の読み込みが重い。
// コサイン類似度は長さに依らないので、ベクトルごとに最大値で割って int8 にし base64 で持つ (1行約1.4KB)。
function packVec(v: number[]): string {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const k = max ? 127 / max : 0;
  const bytes = new Uint8Array(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = Math.round(v[i] * k) & 0xff;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unpackVec(s: string): Int8Array {
  const raw = atob(s);
  const out = new Int8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = (raw.charCodeAt(i) << 24) >> 24;
  return out;
}
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * text に似た型を最大 limit 件返す。excludeSourceIds はそのタスク自身から起こした型を除くため。
 * canSee は元タスクを呼び手に見せてよいか (スコープ判定)。
 * ai があれば意味で選ぶ。埋め込みの無い型 (過去分・書き直した型) は、ここでついでに取って保存する。
 */
export async function findPrecedents(
  db: D1Database,
  wsId: string,
  text: string,
  opts: { ai?: Ai; excludeSourceIds?: string[]; limit?: number; canSee: (goalId: string) => Promise<boolean> }
): Promise<Precedent[]> {
  if (text.trim().length < 4) return [];
  // 失敗を「似た型なし」にすり替えない (AGENTS.md 1)。呼び手のツールごと失敗させる。
  const res = await db
    .prepare(
      `SELECT id, source_goal_id, author_name, title, keywords, steps, pitfalls, commits, updated_at, embedding, embedding_model
         FROM playbooks WHERE workspace_id = ? ORDER BY updated_at DESC, id LIMIT ?`
    )
    .bind(wsId, SCAN_LIMIT)
    .all<PlaybookRow & { embedding: string | null; embedding_model: string | null }>();
  const rows = res.results ?? [];
  if (!rows.length) return [];
  const exclude = new Set(opts.excludeSourceIds ?? []);
  const limit = opts.limit ?? 3;

  let scored: { r: PlaybookRow; s: number }[];
  if (opts.ai) {
    const missing = rows.filter((r) => !r.embedding || r.embedding_model !== EMBED_MODEL);
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const chunk = missing.slice(i, i + EMBED_BATCH);
      const vecs = await embed(opts.ai, chunk.map(playbookText));
      for (let j = 0; j < chunk.length; j++) {
        chunk[j].embedding = packVec(vecs[j]);
        chunk[j].embedding_model = EMBED_MODEL;
      }
      await db.batch(
        chunk.map((r) =>
          db.prepare("UPDATE playbooks SET embedding = ?, embedding_model = ? WHERE id = ? AND workspace_id = ?")
            .bind(r.embedding, EMBED_MODEL, r.id, wsId)
        )
      );
    }
    const [qv] = await embed(opts.ai, [text.slice(0, 1000)]);
    scored = rows
      .filter((r) => !r.source_goal_id || !exclude.has(r.source_goal_id))
      .map((r) => ({ r, s: cosine(qv, unpackVec(r.embedding!)) }))
      .filter((x) => x.s >= MIN_SIMILARITY);
  } else {
    const q = grams(text);
    const docs = rows.map((r) => grams(`${r.title}\n${r.keywords ?? ""}`));
    const df = new Map<string, number>();
    for (const d of docs) for (const g of d) df.set(g, (df.get(g) ?? 0) + 1);
    const idf = (g: string) => Math.log(1 + docs.length / (df.get(g) ?? 1)) / Math.log(1 + docs.length);
    scored = rows
      .map((r, i) => ({ r, s: overlapScore(q, docs[i], idf) }))
      .filter(({ r }) => !r.source_goal_id || !exclude.has(r.source_goal_id))
      .filter((x) => x.s >= MIN_SCORE);
  }
  scored = scored.sort((a, b) => b.s - a.s);
  if (opts.ai && scored.length) scored = scored.filter((x) => x.s >= scored[0].s - NEAR_BEST);
  scored = scored.slice(0, limit);

  const out: Precedent[] = [];
  for (const { r, s } of scored) {
    const p: Precedent = {
      playbook_id: r.id,
      title: r.title,
      by: r.author_name || "記録なし",
      steps: r.steps,
      updated_at: r.updated_at,
    };
    if (opts.ai) p.similarity = Math.round(s * 100) / 100;
    if (r.pitfalls?.trim()) p.pitfalls = r.pitfalls;
    if (r.commits) {
      try {
        const c = JSON.parse(r.commits) as PlaybookCommit[];
        if (Array.isArray(c) && c.length) p.commits = c;
      } catch { /* 壊れた JSON は出さない */ }
    }
    if (r.source_goal_id && (await opts.canSee(r.source_goal_id))) {
      const g = await db
        .prepare("SELECT name FROM projects WHERE id = ? AND workspace_id = ?")
        .bind(r.source_goal_id, wsId)
        .first<{ name: string | null }>();
      if (g?.name) p.source_task = { id: r.source_goal_id, name: g.name };
    }
    out.push(p);
  }
  return out;
}

/** 返り値に添える説明。型をどう扱うかを AI に毎回伝える。 */
export const PRECEDENTS_NOTE =
  "precedents は、似た仕事を以前メンバーがやったときの型 (手順・気をつけたこと・コミット)。自動で選んでいるので、" +
  "このタスクと関係ないものは黙って無視してよい。関係あるものは作業ステップを組む前に読み、使える手順はそのまま使う。" +
  "合わない所は変えてよいが、変えた理由を現状に一言書く。" +
  "commits があればそのコミットの差分を見てから着手すると早い。";

// 全員に見せる前提なので、明らかな個人情報・金額は入口で止める。
// ここで止まる文面は、書き手の AI が一般化して書き直せる。
export function privacyProblem(text: string): string | null {
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return "メールアドレス";
  if (/0\d{1,4}-\d{1,4}-\d{3,4}/.test(text)) return "電話番号";
  if (/[¥￥]\s?\d|\d[\d,]*\s?(円|万円)/.test(text)) return "金額";
  if (/(sk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9]{10,}/.test(text)) return "キー・トークン";
  return null;
}

export async function upsertPlaybook(
  db: D1Database,
  wsId: string,
  input: {
    id: string;
    sourceGoalId: string;
    authorName: string | null;
    authorEmail: string | null;
    title: string;
    keywords: string[];
    steps: string;
    pitfalls: string | null;
    commits: PlaybookCommit[];
    now: string;
  }
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .prepare("SELECT id FROM playbooks WHERE workspace_id = ? AND source_goal_id = ?")
    .bind(wsId, input.sourceGoalId)
    .first<{ id: string }>();
  const commits = input.commits.length ? JSON.stringify(input.commits) : null;
  const keywords = input.keywords.map((k) => k.trim()).filter(Boolean).join("\n") || null;
  if (existing) {
    await db
      .prepare(
        `UPDATE playbooks SET title = ?, keywords = ?, steps = ?, pitfalls = ?, commits = ?,
                author_name = ?, author_email = ?, updated_at = ?, embedding = NULL, embedding_model = NULL
          WHERE id = ? AND workspace_id = ?`
      )
      .bind(input.title, keywords, input.steps, input.pitfalls, commits, input.authorName, input.authorEmail, input.now, existing.id, wsId)
      .run();
    return { id: existing.id, created: false };
  }
  await db
    .prepare(
      `INSERT INTO playbooks (id, workspace_id, source_goal_id, author_name, author_email, title, keywords, steps, pitfalls, commits, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(input.id, wsId, input.sourceGoalId, input.authorName, input.authorEmail, input.title, keywords, input.steps, input.pitfalls, commits, input.now, input.now)
    .run();
  return { id: input.id, created: true };
}

/**
 * 完了したタスクが型に起こす価値のあるものか。作業ステップ (子も現状も無い1行タスク) まで
 * 型にすると型がノイズで埋まるので、子タスクを持つか現状が書かれているものだけにする。
 */
export async function shouldRecordPlaybook(db: D1Database, wsId: string, goalId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT length(coalesce(current_state, '')) AS state_len,
              (SELECT COUNT(*) FROM projects c WHERE c.parent_goal_id = p.id AND c.workspace_id = p.workspace_id) AS kids,
              (SELECT COUNT(*) FROM playbooks b WHERE b.source_goal_id = p.id AND b.workspace_id = p.workspace_id) AS has_pb
         FROM projects p WHERE p.id = ? AND p.workspace_id = ?`
    )
    .bind(goalId, wsId)
    .first<{ state_len: number; kids: number; has_pb: number }>();
  if (!row || row.has_pb > 0) return false;
  return row.kids > 0 || row.state_len > 80;
}

export function recordPlaybookAction(goalId: string): string {
  return (
    `このタスク (${goalId}) を型として record_playbook で残す。次に同じ種類の仕事をするメンバーの AI に自動で渡る。` +
    "title は一般化した「何をするときの型か」、steps は実際にやった順の手順、pitfalls はつまずいたこと。" +
    "顧客名・個人名・金額・連絡先は書かず「顧客」「先方」と一般化する。" +
    `コードを変えたなら git log --all --grep "${goalId}" でコミットを拾い、commits に repo と sha を入れる。`
  );
}
