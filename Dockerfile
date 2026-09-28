# こつこつの Docker 版。Cloudflare を使わず、Docker が動く所ならどこでも立つ。
# 使い方は docs/self-hosting-docker.md (npm run setup:docker がこれをビルドして起動する)。

# ---- ビルド ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp-worker/package.json mcp-worker/package-lock.json mcp-worker/
RUN npm ci && cd mcp-worker && npm ci
COPY . .
# 画面は Node 用にビルドし、MCP (mcp-worker) は1ファイルにまとめる
RUN npm run build:node && npm prune --omit=dev

# ---- 実行 ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    KOTSUKOTSU_RUNTIME=node \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/d1-migrations ./d1-migrations
COPY --from=build /app/node-server ./node-server
# データ (SQLite とファイル) はボリュームに置く。コンテナを作り直しても消えない
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "node-server/server.mjs"]
