# =============================================================================
# Web image — multi-stage, node:20-alpine, Next.js standalone, non-root.
# Build context is the REPO ROOT (pnpm workspace).
#   docker build -f apps/web/Dockerfile -t sms-web .
# =============================================================================

FROM node:20-alpine AS base
# Bake pnpm into the layer with retries — corepack's lazy first-use download has
# no retry and dies on one flaky DNS reply (EAI_AGAIN). See apps/api/Dockerfile.
RUN corepack enable \
 && for i in 1 2 3 4 5; do corepack prepare pnpm@9.12.0 --activate && break; \
      [ "$i" = 5 ] && exit 1; echo "corepack prepare failed (attempt $i) — retrying in 5s"; sleep 5; done
WORKDIR /app

# ---- deps -------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY packages/types/package.json   packages/types/package.json
COPY packages/tokens/package.json  packages/tokens/package.json
COPY packages/db/package.json      packages/db/package.json
COPY apps/api/package.json         apps/api/package.json
COPY apps/web/package.json         apps/web/package.json
# @sms/db's postinstall runs `prisma generate`, which needs the schema present.
COPY packages/db/prisma            packages/db/prisma
# Shared store + prisma-engine caches, patient retries, IPv4-first DNS — same
# rationale as the API image (no IPv6 route; WiFi drops out for minutes).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=prisma-cache,target=/root/.cache/prisma \
    for i in 1 2 3 4 5 6; do \
      NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=10000" \
        pnpm install --frozen-lockfile --store-dir /pnpm-store && exit 0; \
      [ "$i" = 6 ] && exit 1; echo "pnpm install failed (attempt $i) — retrying in 20s"; sleep 20; \
    done

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
