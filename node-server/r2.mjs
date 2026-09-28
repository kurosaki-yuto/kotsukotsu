// サーバーのディスクを、Cloudflare R2 と同じ呼び方 (put / get / delete / list) で使えるようにする。
// Docker 版ではこれを env.FILES として渡す。ファイルは DATA_DIR/files/ の下に置く。
// キー (例: <ワークスペースid>/<ゴールid>/<名前>) の / はそのままフォルダになる。

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export function fileBucket(root) {
  fs.mkdirSync(root, { recursive: true });
  const base = path.resolve(root);

  // ルートの外に出るキー (../ など) は受け付けない
  const fileOf = (key) => {
    const p = path.resolve(base, key);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`invalid key: ${key}`);
    return p;
  };
  const metaOf = (p) => `${p}.meta.json`;

  async function toBuffer(body) {
    if (body == null) return Buffer.alloc(0);
    if (typeof body === "string") return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (typeof body.getReader === "function") return Buffer.from(await new Response(body).arrayBuffer());
    if (typeof body.arrayBuffer === "function") return Buffer.from(await body.arrayBuffer());
    throw new Error("unsupported body");
  }

  return {
    async put(key, body, opts = {}) {
      const p = fileOf(key);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const buf = await toBuffer(body);
      fs.writeFileSync(p, buf);
      fs.writeFileSync(metaOf(p), JSON.stringify({ httpMetadata: opts.httpMetadata ?? {}, uploaded: new Date().toISOString() }));
      return { key, size: buf.length };
    },
    async get(key) {
      const p = fileOf(key);
      if (!fs.existsSync(p)) return null;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaOf(p), "utf8")); } catch { /* メタ情報なし */ }
      const size = fs.statSync(p).size;
      const httpMetadata = meta.httpMetadata ?? {};
      return {
        key,
        size,
        httpMetadata,
        get body() { return Readable.toWeb(fs.createReadStream(p)); },
        async arrayBuffer() { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        async text() { return fs.readFileSync(p, "utf8"); },
        writeHttpMetadata(headers) { if (httpMetadata.contentType) headers.set("content-type", httpMetadata.contentType); },
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const p = fileOf(key);
        fs.rmSync(p, { force: true });
        fs.rmSync(metaOf(p), { force: true });
      }
    },
    async list({ prefix = "" } = {}) {
      const objects = [];
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (!e.name.endsWith(".meta.json")) {
            const key = path.relative(base, full).split(path.sep).join("/");
            if (key.startsWith(prefix)) objects.push({ key, size: fs.statSync(full).size });
          }
        }
      };
      walk(base);
      return { objects, truncated: false };
    },
  };
}
