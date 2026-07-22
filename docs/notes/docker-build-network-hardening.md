# Docker build network hardening

> Why README docker compose up --build kept failing (host WiFi latency vs Node timeouts) and the Dockerfile hardening that fixed it (2026-07-16)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The dev machine is on **very high-latency, lossy WiFi** (`wlp2s0`, ~15 KB/s effective at
times, multi-minute stalls; resolver 10.23.203.96; docker daemon.json overrides container
DNS to 8.8.8.8/1.1.1.1; NO IPv6 route). This broke `cd infrastructure && docker compose
up --build` in several ways that all look like different bugs but share one root cause:
**short client-side network budgets lose to a link where handshakes take >2.5s**:

1. corepack's lazy pnpm download has NO retry → one dropped DNS reply (musl gives 5s) =
   `EAI_AGAIN` crash killing the whole compose build.
2. Node 20 happy-eyeballs gives each connect() ~250ms → Prisma engine downloads from
   binaries.prisma.sh die `ETIMEDOUT` while curl (no budget) succeeds on the same IP.
3. Prisma engine-flavor mismatch: install stage had no openssl → postinstall defaulted to
   openssl-1.1.x engines; runtime (openssl 3) then tried to download the 3.0.x
   schema-engine ON BOOT and exited.

Fixes (2026-07-16, in `apps/api/Dockerfile` + `apps/web/Dockerfile`, UNCOMMITTED):
- base stage: `apk add openssl` BEFORE install (correct engine detection) + retried
  `corepack prepare pnpm@9.12.0 --activate` (5 attempts).
- install step: 6-attempt retry loop; `NODE_OPTIONS="--dns-result-order=ipv4first
  --network-family-autoselection-attempt-timeout=10000"`; BuildKit cache mounts
  `id=pnpm-store` (shared api↔web) + `id=prisma-cache` (`/root/.cache/prisma`).
- runtime stage no longer needs its own openssl line (comes from base).

**Why:** every Node-driven download on this machine needs patience flags/retries; repo
`.npmrc` already serializes+retries pnpm fetches (keep `network-concurrency=1`).
**How to apply:** if any new Dockerfile/CI step downloads via Node on this host, give it
the same NODE_OPTIONS + retry treatment; expect first full builds to take ~45+ min
(package download is link-bound). Compose build `network: host` IS honored (verified —
build container sees wlp2s0). Full stack verified serving on http://localhost after fix.
Related: [monorepo-scaffolding](monorepo-scaffolding.md), [july-2026-hardening-sweep](july-2026-hardening-sweep.md).
