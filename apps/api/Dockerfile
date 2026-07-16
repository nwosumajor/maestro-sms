# =============================================================================
# API image — multi-stage, node:20-alpine, non-root.
# Build context is the REPO ROOT (the API needs the pnpm workspace).
#   docker build -f apps/api/Dockerfile -t sms-api .
# =============================================================================

# ---- base: pnpm enabled -----------------------------------------------------
FROM node:20-alpine AS base
# openssl must be present in the INSTALL stage, not just runtime: Prisma's
# postinstall detects the libssl version to pick which engines to download.
# Without it, it defaults to the openssl-1.1.x engines — then the runtime image
# (which has openssl 3) demands the openssl-3.0.x schema-engine, finds it
# missing, and tries to fetch it from binaries.prisma.sh on boot, which fails
# without reliable container egress. Detecting correctly here bakes the right
# engines into node_modules at build time.
RUN apk add --no-cache openssl
# Bake pnpm into the layer with retries. corepack otherwise downloads pnpm
# lazily on first use with NO retry — one dropped DNS reply (musl gives the
# resolver a 5s budget) crashes the whole build with EAI_AGAIN on this
# slow/lossy network. Retrying here makes the only unguarded network step safe;
# .npmrc already hardens every pnpm fetch after it.
RUN corepack enable \
 && for i in 1 2 3 4 5; do corepack prepare pnpm@9.12.0 --activate && break; \
      [ "$i" = 5 ] && exit 1; echo "corepack prepare failed (attempt $i) — retrying in 5s"; sleep 5; done
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
# @sms/db's postinstall runs `prisma generate`, which needs the schema present.
COPY packages/db/prisma                   packages/db/prisma
# --dns-result-order=ipv4first: this build host has no IPv6 route, so let Node
# (pnpm + prisma-engine download) resolve the registry over IPv4 (avoids ENETUNREACH).
# The store lives on a shared BuildKit cache mount (id=pnpm-store, shared with the
# web image) so a retry — or the next build — reuses already-fetched packages
# instead of re-downloading ~900 packages over the serialized (.npmrc) connection.
# pnpm copies (not hardlinks) across the mount boundary, so node_modules stays
# fully materialized in the image after the mount unmounts. The prisma cache
# mount does the same for the engine binaries (query/schema engine) that the
# @prisma/engines + `prisma generate` postinstalls download: once fetched they
# survive retries and rebuilds, and Prisma copies them into node_modules so the
# image stays self-contained. 6 patient attempts because this host's WiFi drops
# out for minutes at a time — the loop must outlast a bad window.
# --network-family-autoselection-attempt-timeout: Node 20's happy-eyeballs gives
# each connect() attempt only ~250ms; on this high-latency link the handshake to
# the Prisma CDN regularly exceeds it, so Node downloads die ETIMEDOUT while curl
# (no such budget) succeeds. 10s makes Node as patient as curl.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=prisma-cache,target=/root/.cache/prisma \
    for i in 1 2 3 4 5 6; do \
      NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=10000" \
        pnpm install --frozen-lockfile --store-dir /pnpm-store && exit 0; \
      [ "$i" = 6 ] && exit 1; echo "pnpm install failed (attempt $i) — retrying in 20s"; sleep 20; \
    done

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
# psql for the RLS policies (openssl already in base for the Prisma engine).
RUN apk add --no-cache postgresql-client \
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
