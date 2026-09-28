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
  for (const part of s.split(" ")) {
    if (!part) continue;
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

function similarity(q: Set<string>, d: Set<string>): number {
  if (!q.size || !d.size) return 0;
  let hit = 0;
  for (const g of q) if (d.has(g)) hit++;
  return hit / Math.sqrt(q.size * d.size);
}

// 型の数が増えても毎回全件は読まない。新しい順に一定数だけ見る (見ている範囲は ORDER BY で決定的)。
const SCAN_LIMIT = 400;
const MIN_SCORE = 0.12;

/**
 * text に似た型を最大 limit 件返す。excludeSourceId はそのタスク自身から起こした型を除くため。
 * canSee は元タスクを呼び手に見せてよいか (スコープ判定)。
 */
export async function findPrecedents(
  db: D1Database,
  wsId: string,
  text: string,
  opts: { excludeSourceIds?: string[]; limit?: number; canSee: (goalId: string) => Promise<boolean> }
): Promise<Precedent[]> {
  const q = grams(text);
  if (q.size < 2) return [];
  // 失敗を「似た型なし」にすり替えない (AGENTS.md 1)。呼び手のツールごと失敗させる。
  const res = await db
    .prepare(
      `SELECT id, source_goal_id, author_name, title, keywords, steps, pitfalls, commits, updated_at
         FROM playbooks WHERE workspace_id = ? ORDER BY updated_at DESC, id LIMIT ?`
    )
    .bind(wsId, SCAN_LIMIT)
    .all<PlaybookRow>();
  const rows = res.results ?? [];
  const exclude = new Set(opts.excludeSourceIds ?? []);
  const scored = rows
    .filter((r) => !r.source_goal_id || !exclude.has(r.source_goal_id))
    .map((r) => ({ r, s: similarity(q, grams(`${r.title}\n${r.title}\n${r.keywords ?? ""}`)) }))
    .filter((x) => x.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.limit ?? 3);

  const out: Precedent[] = [];
  for (const { r } of scored) {
    const p: Precedent = {
      playbook_id: r.id,
      title: r.title,
      by: r.author_name || "記録なし",
      steps: r.steps,
      updated_at: r.updated_at,
    };
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
  "precedents は、同じ種類の仕事を以前メンバーがやったときの型 (手順・気をつけたこと・コミット)。" +
  "作業ステップを組む前に読み、使える手順はそのまま使う。合わない所は変えてよいが、変えた理由を現状に一言書く。" +
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
                author_name = ?, author_email = ?, updated_at = ?
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
