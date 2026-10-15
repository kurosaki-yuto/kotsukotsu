// サーバーのディスクを、Cloudflare R2 と同じ呼び方 (put / get / head / delete / list / マルチパート) で使えるようにする。
// Docker 版ではこれを env.FILES として渡す。ファイルは DATA_DIR/files/ の下に置く。
// キー (例: <ワークスペースid>/<ゴールid>/<名前>) の / はそのままフォルダになる。

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import crypto from "node:crypto";

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
  // 分割アップロードの途中のファイル。完了したら1つにまとめて消す
  const partsDir = path.join(base, ".multipart");
  const uploadDir = (uploadId) => {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error("invalid uploadId");
    return path.join(partsDir, uploadId);
  };
  const readMeta = (p) => { try { return JSON.parse(fs.readFileSync(metaOf(p), "utf8")); } catch { return {}; } };

  function multipart(key, uploadId) {
    const dir = uploadDir(uploadId);
    return {
      key,
      uploadId,
      async uploadPart(partNumber, body) {
        if (!fs.existsSync(dir)) throw new Error("upload not found");
        const buf = await toBuffer(body);
        fs.writeFileSync(path.join(dir, String(partNumber)), buf);
        return { partNumber, etag: crypto.createHash("md5").update(buf).digest("hex") };
      },
      async complete(parts) {
        if (!fs.existsSync(dir)) throw new Error("upload not found");
        const p = fileOf(key);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const out = fs.openSync(p, "w");
        try {
          for (const { partNumber } of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
            fs.writeSync(out, fs.readFileSync(path.join(dir, String(partNumber))));
          }
        } finally { fs.closeSync(out); }
        let opts = {};
        try { opts = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch { /* 無し */ }
        fs.writeFileSync(metaOf(p), JSON.stringify({ httpMetadata: opts.httpMetadata ?? {}, uploaded: new Date().toISOString() }));
        fs.rmSync(dir, { recursive: true, force: true });
        return { key, size: fs.statSync(p).size };
      },
      async abort() { fs.rmSync(dir, { recursive: true, force: true }); },
    };
  }

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
    async head(key) {
      const p = fileOf(key);
      if (!fs.existsSync(p)) return null;
      return { key, size: fs.statSync(p).size, httpMetadata: readMeta(p).httpMetadata ?? {} };
    },
    async get(key, opts = {}) {
      const p = fileOf(key);
      if (!fs.existsSync(p)) return null;
      const meta = readMeta(p);
      const size = fs.statSync(p).size;
      const httpMetadata = meta.httpMetadata ?? {};
      // R2 と同じく {range: {offset, length}} で一部だけ読む (動画のシーク用)
      const r = opts.range && typeof opts.range.offset === "number" ? opts.range : null;
      const stream = () => r
        ? fs.createReadStream(p, { start: r.offset, end: r.offset + (r.length ?? size - r.offset) - 1 })
        : fs.createReadStream(p);
      return {
        key,
        size,
        httpMetadata,
        ...(r ? { range: r } : {}),
        get body() { return Readable.toWeb(stream()); },
        async arrayBuffer() { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        async text() { return fs.readFileSync(p, "utf8"); },
        writeHttpMetadata(headers) { if (httpMetadata.contentType) headers.set("content-type", httpMetadata.contentType); },
      };
    },
    async createMultipartUpload(key, opts = {}) {
      fileOf(key); // ルートの外に出るキーはここで止める
      const uploadId = crypto.randomUUID();
      const dir = uploadDir(uploadId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ httpMetadata: opts.httpMetadata ?? {} }));
      return multipart(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      fileOf(key);
      return multipart(key, uploadId);
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
          if (e.isDirectory()) { if (full !== partsDir) walk(full); }
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
