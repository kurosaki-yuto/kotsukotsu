// mcp-worker (Cloudflare Worker として書かれた MCP サーバー) を、Node で読み込める1ファイルにまとめる。
// 出力: node-server/dist/mcp.mjs。Docker のビルド時と、手元で node-server を試すときに実行する。

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "../mcp-worker/src/index.ts")],
  outfile: path.join(here, "dist/mcp.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // mcp-worker の依存 (zod など) は mcp-worker/node_modules にある
  nodePaths: [path.join(here, "../mcp-worker/node_modules")],
  logLevel: "warning",
});
console.log("built node-server/dist/mcp.mjs");
