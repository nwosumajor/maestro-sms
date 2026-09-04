# SMS — School Management System (foundation + Assessment Integrity)

Turborepo + pnpm monorepo.

```
apps/web      Next.js (App Router) + Auth.js  — UI, sessions, BFF proxy
apps/api      NestJS                          — stateless API, verifies JWT, RLS, BullMQ
packages/types  shared DTOs / Zod / permission constants
packages/db     Prisma schema, migrations, RLS SQL
packages/tokens design tokens (cross-platform)
```

## Prerequisites
- Node 20+, pnpm 9, **PostgreSQL 16+**, Redis 6+.

> 16 is the real floor, not a preference — local/CI/prod all run 16 (`postgres:16-alpine`,
> Terraform `engine_version = "16"`). Older majors don't just warn, they fail:
> `audit_log` is partitioned with a foreign key **from** a partitioned table (needs PG 12+),
> the RLS coverage gate reads `pg_class.relispartition` (10+), tenant isolation relies on
> `FORCE ROW LEVEL SECURITY` (9.5+), and migrations/seeding call `gen_random_uuid()`
> unqualified (built in from 13; earlier needs the `pgcrypto` extension).
> Also verified green on PostgreSQL 18 — see CLAUDE.md.

## Local development (native: web :3000 + api :3001 + dockerised DB)

The fast edit-reload loop: Postgres/Redis in Docker, web + api natively on the host.

**1 — dependencies + Prisma client**
```bash
pnpm install
pnpm db:generate
```

**2 — Postgres + Redis on the host.** The base compose publishes NO host ports
(only nginx is exposed in the full stack), so use the dev override, which adds
just those two port mappings:
```bash
cd infrastructure
cp .env.example .env      # first time only
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
# → Postgres localhost:5433, Redis localhost:6379
```

**3 — create the schema (first time, or after new migrations).** RLS is applied
SEPARATELY from the Prisma migration, on purpose (CLAUDE.md) — tables run as the
privileged role; the app connects as the least-privilege `major_user`.
```bash
export DATABASE_URL='postgresql://major_user:change-me-app@localhost:5433/sms'
export DATABASE_MIGRATE_URL='postgresql://postgres:change-me-superuser@localhost:5433/sms'
pnpm --filter @sms/db setup      # migrate deploy + apply RLS + seed
```

**4 — API on :3001.** NOTE: the API does **not** read a `.env` file (no dotenv /
ConfigModule) — it reads `process.env`, so the vars must be **exported in the
shell that launches it**. `AUTH_SECRET` MUST equal the one in `apps/web/.env.local`:
the web *signs* the session JWT and the API *verifies* it — a mismatch 401s every
request.
```bash
cd apps/api
export DATABASE_URL='postgresql://major_user:change-me-app@localhost:5433/sms'
export DATABASE_MIGRATE_URL='postgresql://postgres:change-me-superuser@localhost:5433/sms'
export AUTH_SECRET='dev-secret-verify-please-change'    # must match apps/web/.env.local
export REDIS_HOST=127.0.0.1 REDIS_PORT=6379
export API_PORT=3001 WEB_ORIGIN=http://localhost:3000
export DATA_ENCRYPTION_KEY='Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE='   # dev-only key
pnpm dev            # nest start --watch  (or: node dist/main.js after pnpm build)
```

**5 — web on :3000** (reads `apps/web/.env.local` itself; needs `AUTH_SECRET` +
`API_BASE_URL=http://localhost:3001`):
```bash
cd apps/web && pnpm dev
```

Then open **http://localhost:3000**.

### Alternative: the whole stack in Docker
```bash
cd infrastructure && cp .env.example .env && docker compose up --build
```
Serves on **http://localhost** (port 80, via nginx) — not :3000. Here web+api both
take `AUTH_SECRET` from `infrastructure/.env`, so they always agree.

#### Build notes (slow / flaky networks)
The image builds are hardened for high-latency links, where three failures used
to masquerade as a broken compose file:

- **`EAI_AGAIN registry.npmjs.org`** — corepack's lazy download of pnpm has no
  retry, and musl gives DNS only ~5s. The base stage now bakes pnpm in via
  `corepack prepare` with a retry loop.
- **`ETIMEDOUT` fetching Prisma engines** — Node 20's happy-eyeballs gives each
  connect attempt ~250ms, which a congested link blows past even though `curl`
  succeeds on the same URL. `pnpm install` now runs with
  `--network-family-autoselection-attempt-timeout=10000` inside a 6-attempt
  retry loop.
- **Backend exiting at boot fetching `schema-engine`** — the install stage must
  have `openssl` so Prisma detects the runtime libssl (3.x) and bundles the
  matching engines at build time; the runtime container is not guaranteed egress
  to binaries.prisma.sh. Baked into the base stage — don't remove it.

Expectations: the FIRST full build downloads the whole workspace (~950 packages
per image) and is download-bound — on a slow connection allow **45+ minutes**.
Rebuilds are fast: the pnpm store and Prisma engine cache live on shared
BuildKit cache mounts (`id=pnpm-store`, `id=prisma-cache`), reused across
retries, rebuilds, and both images. `.npmrc` deliberately serializes fetches
(`network-concurrency=1`) for reliability over speed — keep it. If a build
still dies mid-download, just re-run it; everything already fetched is cached.

---

Sign in at http://localhost:3000 with a demo account (dev only) — password
`password123`: `teacher@` / `student@` / `parent@` / `admin@` / `principal@` /
`hrmanager@` / `warden@` / `librarian@demo.school`, etc. — one per **school-scoped
role** (see CLAUDE.md for the full list). There are 19 roles in all: those 17 plus
the two PLATFORM roles, `owner@sms.platform` (super_admin) and
`manager@sms.platform` (manager_admin).

> Demo fixtures are **fail-closed**: nothing above is created unless
> `SEED_DEMO_DATA=true`, which `infrastructure/.env.example` sets for local work
> and which must NEVER be set in cloud. The seed still runs in production for
> the platform org, the SYSTEM audit actor and the role/permission registry —
> that last one must keep re-running, because a newly added permission only
> reaches a live database when the seed does.

## Test
```bash
pnpm test                          # all workspaces (web, types, engines)
pnpm --filter @sms/api test        # API unit + gate specs — SKIPS the DB suites
pnpm --filter @sms/api test:db     # everything, including the RLS e2e suite
```

> **`test:db` is the one that runs all of it.** A bare `jest` skips every
> DB-gated suite — each `describe.skip`s without `TEST_DATABASE_URL` — so a
> green local run says nothing about a large minority of the tests, including
> the cross-tenant RLS cases, which are the most important category here. The
> bare run now prints the skipped count and this command. `test:db` reads
> `infrastructure/.env`, points at the `sms-test-pg` container on **5434**, and
> supplies the four variables the suites need: `TEST_DATABASE_URL` (app role),
> `TEST_ADMIN_URL` (superuser, to seed across FKs), `DATABASE_URL` (the `@sms/db`
> singleton the service e2es go through) and `AUTH_SECRET` (the storage stub
> signs presigned URLs with it — without it a report-card vault write fails
> inside a best-effort catch and the suite fails two assertions later).

## Documentation
- **[CLAUDE.md](CLAUDE.md)** — the durable spec: golden rules, stack, multi-tenancy
  and RBAC models, build status, the defect classes that keep recurring, repo
  gotchas. Start here.
- **[docs/ENGINEERING-LOG.md](docs/ENGINEERING-LOG.md)** — 248 write-ups of real
  defects found and fixed: what was wrong, how it was measured, what was decided
  and why, and the gotchas that cost time. These were 87% of CLAUDE.md; the RULES
  were distilled into it and the INSTANCES live here. Grep it for a defect's
  shape before fixing one — most are the second or third of a class already
  recorded.
- **[API.md](API.md)** — every HTTP endpoint with its permission / module / step-up
  gate. **Generated** from the controllers (`pnpm --filter @sms/api build:api-doc`)
  and gated by `api-doc-is-current.spec.ts`, so it cannot drift from the code.
  Improve a description by writing a doc comment on the handler, or by editing
  `apps/api/scripts/api-doc-purposes.json` — never by hand-editing API.md.
- **[docs/notes/](docs/notes/README.md)** — engineering notes from the build sessions:
  why designs went the way they did, and the gotchas that cost real time. Point-in-time
  records, so verify specifics against the code.
- **[docs/RUNBOOK-INCIDENT-RESPONSE.md](docs/RUNBOOK-INCIDENT-RESPONSE.md)** — the
  on-call playbook: severity levels, five-minute triage, per-symptom procedures
  (outage, latency, DB, Redis, bad deploy, payments, auth, **tenant-isolation
  breach**, data loss, scheduled jobs), rollback, and the post-mortem template.
- **[docs/RUNBOOK-BACKUP-RESTORE.md](docs/RUNBOOK-BACKUP-RESTORE.md)** — what is backed
  up, how to restore for real, and the restore drill that proves a backup is usable.
- **[docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md)** — the Terraform /
  ECS deploy path and the environment it expects.
- **[docs/ONBOARDING-MANUAL.html](docs/ONBOARDING-MANUAL.html)** — the school leader's
  manual, served in-app at `/manual`. After editing it run
  `pnpm --filter @sms/web build:manual`; `pricing-consistency.test.ts` fails if the
  served copy is stale or if either owner-facing document quotes a price that no
  longer matches `@sms/types`.

## Auth flow (who trusts what)
- **Auth.js** (web) owns login + session and stamps `school_id`/`roles`/`permissions`.
- **Server Components** mint a short-lived HS256 service token from the session and
  call the API directly with `Authorization: Bearer …`.
- **Browser** calls go to the same-origin **BFF proxy** (`/api/sms/*`), which injects
  the Bearer server-side — the browser never holds a verifiable API token.
- **API** verifies the JWT on every request, then enforces permission → tenant → RLS.

## Known unbound integration
- `EMBEDDING_PROVIDER` (`apps/api/src/integrity`) — an `@Optional()` injection with
  no binding, so **prose similarity detection is skipped**. Code similarity
  (n-gram/shingling) and every other integrity detector run regardless. Bind a
  provider to switch it on; nothing else is waiting on it.

Everything the earlier draft of this section listed as a placeholder is built:
the foundation `AuditLog`/`Consent` services are the real ones (see
`FoundationModule`'s `useClass` bindings), the Prisma foundation stub is gone,
and `apps/web/lib/auth.ts` authenticates against the real `POST /auth/login`
rather than demo credentials.
