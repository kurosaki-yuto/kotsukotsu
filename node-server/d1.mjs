// SQLite ファイルを、Cloudflare D1 と同じ呼び方 (prepare().bind().first/all/run、batch、exec) で使えるようにする。
// アプリと MCP のコードは D1 を前提に書かれているので、Docker 版ではこれを env.DB として渡す。
// D1 の中身も SQLite なので、SQL とマイグレーション (d1-migrations/) はそのまま使える。
//
// Node 標準の node:sqlite を使う (追加のネイティブモジュールが要らない)。

import { DatabaseSync } from "node:sqlite";

// node:sqlite は ?1 ?2 の番号付き引数をそのままでは受け付けないので、$p1 $p2 の名前付きに読み替える。
const NUMBERED = /\?(\d+)/g;

function toValue(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;
}

function params(sql, args) {
  const values = args.map(toValue);
  if (!NUMBERED.test(sql)) return { sql, bind: values };
  NUMBERED.lastIndex = 0;
  const named = {};
  values.forEach((v, i) => { named[`p${i + 1}`] = v; });
  return { sql: sql.replace(NUMBERED, (_, n) => `$p${n}`), bind: [named] };
}

const RETURNS_ROWS = /^\s*(select|with|pragma|values)\b|\breturning\b/i;

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }
  #prep() {
    const p = params(this.sql, this.args);
    return { stmt: this.db.prepare(p.sql), bind: p.bind };
  }
  runSync() {
    const { stmt, bind } = this.#prep();
    if (RETURNS_ROWS.test(this.sql)) {
      const rows = stmt.all(...bind);
      return { success: true, results: rows, meta: { changes: 0, rows_read: rows.length } };
    }
    const r = stmt.run(...bind);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(column) {
    const { stmt, bind } = this.#prep();
    const row = stmt.get(...bind);
    if (!row) return null;
    return column ? row[column] ?? null : { ...row };
  }
  async all() {
    const { stmt, bind } = this.#prep();
    const rows = stmt.all(...bind).map((r) => ({ ...r }));
    return { success: true, results: rows, meta: { rows_read: rows.length } };
  }
  async run() {
    return this.runSync();
  }
  async raw() {
    const { stmt, bind } = this.#prep();
    return stmt.all(...bind).map((r) => Object.values(r));
  }
}

export function openD1(file) {
  const db = new DatabaseSync(file);
  // D1 と同じく外部キーを有効に。WAL で読み書きを並べやすくする
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return {
    prepare: (sql) => new Statement(db, sql),
    // D1 の batch はまとめて1つのトランザクション。途中で失敗したら全部戻す
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    _raw: db,
  };
}

// d1-migrations/ を wrangler と同じ d1_migrations 表で管理して、まだ当てていないものだけ当てる。
// Cloudflare 版と同じく、1ファイルずつトランザクションで当てる。
export async function applyMigrations(d1, dir, fs, path) {
  const db = d1._raw;
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const done = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
      db.exec("COMMIT");
      applied.push(f);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`マイグレーション ${f} を当てられませんでした: ${e.message}`);
    }
  }
  return applied;
}
