# =============================================================================
# API image — multi-stage, node:20-alpine, non-root.
# Build context is the REPO ROOT (the API needs the pnpm workspace).
#   docker build -f apps/api/Dockerfile -t sms-api .
# =============================================================================

# ---- base: pnpm enabled -----------------------------------------------------
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install the whole workspace (cached on lockfile) ------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY packages/types/package.json          packages/types/package.json
COPY packages/tokens/package.json         packages/tokens/package.json
COPY packages/db/package.json             packages/db/package.json
COPY packages/game-engine/package.json    packages/game-engine/package.json
COPY packages/game-transport/package.json packages/game-transport/package.json
COPY apps/api/package.json                apps/api/package.json
COPY apps/web/package.json                apps/web/package.json
RUN pnpm install --frozen-lockfile

# ---- build: generate client, build packages + api ---------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @sms/db generate \
 && pnpm --filter @sms/types build \
 && pnpm --filter @sms/tokens build \
 && pnpm --filter @sms/db build \
 && pnpm --filter @sms/game-engine build \
 && pnpm --filter @sms/game-transport build \
 && pnpm --filter @sms/api build
# NOTE: do NOT `pnpm prune --prod` here — it strips the Prisma query-engine binary
# that `prisma generate` bundled into node_modules/.prisma, and the runtime
# container has no egress to binaries.prisma.sh to re-download it. Keeping the full
# node_modules makes the image larger but self-contained (no runtime downloads).

# ---- runtime: prod deps + dist only, drop root ------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# psql for the RLS policies; openssl so the Prisma (musl) engine can load libssl.
RUN apk add --no-cache postgresql-client openssl \
 && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules           ./node_modules
COPY --from=build --chown=app:app /app/packages               ./packages
COPY --from=build --chown=app:app /app/apps/api/dist          ./apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/node_modules  ./apps/api/node_modules
COPY --from=build --chown=app:app /app/apps/api/package.json  ./apps/api/package.json
COPY --chown=app:app apps/api/docker-entrypoint.sh         ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER app
EXPOSE 3001
ENTRYPOINT ["./docker-entrypoint.sh"]
