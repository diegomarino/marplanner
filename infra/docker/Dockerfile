# Multi-platform official Node index; native dependencies install on the target OS.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
WORKDIR /app
RUN test "$(node --version)" = "v24.21.0" \
    && npm install --global npm@11.19.0 \
    && test "$(npm --version)" = "11.19.0"

FROM base AS dependencies
# Native modules may compile when no target-specific prebuilt binary exists.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY index.html vite.config.ts tsconfig*.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY tools/check-plugin-events.mjs tools/
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data DATABASE_PATH=marplanner.db
COPY --from=production-dependencies /app/node_modules/ node_modules/
COPY --from=build /app/dist/client/ dist/client/
COPY --from=build /app/dist/server/ dist/server/
COPY --from=build /app/dist/daily-briefing-render/ dist/daily-briefing-render/
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY drizzle/ drizzle/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server/index.js"]
