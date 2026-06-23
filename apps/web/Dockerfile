# =============================================================================
# Web image — multi-stage, node:20-alpine, Next.js standalone, non-root.
# Build context is the REPO ROOT (pnpm workspace).
#   docker build -f apps/web/Dockerfile -t sms-web .
# =============================================================================

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- deps -------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY packages/types/package.json   packages/types/package.json
COPY packages/tokens/package.json  packages/tokens/package.json
COPY packages/db/package.json      packages/db/package.json
COPY apps/api/package.json         apps/api/package.json
COPY apps/web/package.json         apps/web/package.json
RUN pnpm install --frozen-lockfile

# ---- build: workspace deps + next standalone --------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @sms/types build \
 && pnpm --filter @sms/tokens build \
 && pnpm --filter @sms/web build

# ---- runtime: standalone output only, drop root -----------------------------
FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
# Next standalone bundles the server + traced node_modules under .next/standalone.
COPY --from=build --chown=app:app /app/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=app:app /app/apps/web/public           ./apps/web/public
USER app
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
