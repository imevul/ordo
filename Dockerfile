# syntax=docker/dockerfile:1

# ─── build ─────────────────────────────────────────────────────────────
FROM node:26-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@12.15.0

# Install dependencies first so they cache independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @ordo/web build && pnpm --filter @ordo/api build

# ─── runtime ───────────────────────────────────────────────────────────
# The API is bundled into one file, so the runtime image needs no node_modules.
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ORDO_STATIC_DIR=/app/public \
    ORDO_MIGRATIONS_DIR=/app/drizzle

COPY --from=build /src/apps/api/dist ./
COPY --from=build /src/apps/api/drizzle ./drizzle
COPY --from=build /src/apps/api/package.json ./package.json
COPY --from=build /src/apps/web/dist ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "server.mjs"]
