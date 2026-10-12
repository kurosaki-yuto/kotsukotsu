// ESLint (flat config)。npm run lint で本体・mcp-worker・realtime-worker・scripts を見る。
// Next の推奨 (core-web-vitals) + TypeScript の推奨。ルールを足すときはここに理由を書く。
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".open-next/**",
    "**/.wrangler/**",
    "node_modules/**",
    "**/node_modules/**",
    "node-server/dist/**",
    "public/**",
    "backups/**",
    "oss-stats/**",
    "pages-proxy/**",
    "next-env.d.ts",
    "cloudflare-env.d.ts",
    "worker-configuration.d.ts",
    "*.tsbuildinfo",
  ]),
  {
    rules: {
      // 画面の画像は data URL (アバター) と R2 のファイルで、next/image の最適化を通さない
      "@next/next/no-img-element": "off",
      // この app はデータ取得ライブラリを使わず、effect の中で fetch → setState する作り (ページ・一覧・設定で 25 箇所)。
      // React Compiler 向けのこのルールは、それを「連鎖レンダー」として一律に止めるので外す。新しく書くときは useAutoRefresh や
      // イベントハンドラでの更新を優先する。
      "react-hooks/set-state-in-effect": "off",
      // _ で始まる引数・変数は「使わない」の印
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    // Cloudflare Worker の入口は `export default { fetch, scheduled }` が決まりの形
    files: ["mcp-worker/src/**/*.ts", "realtime-worker/src/**/*.ts"],
    rules: { "import/no-anonymous-default-export": "off" },
  },
]);
