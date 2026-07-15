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

---

Sign in at http://localhost:3000 with a demo account (dev only) — password
`password123`: `teacher@` / `student@` / `parent@` / `admin@` / `principal@` /
`hrmanager@` / `warden@` / `librarian@demo.school`, etc. (see CLAUDE.md for the
full 17-role list; platform owner is `owner@sms.platform`).

## Test
```bash
pnpm test                         # all workspaces
pnpm --filter @sms/api test       # integrity unit + detector + report specs
TEST_DATABASE_URL=... pnpm --filter @sms/api test  # includes the RLS e2e suite
```

## Auth flow (who trusts what)
- **Auth.js** (web) owns login + session and stamps `school_id`/`roles`/`permissions`.
- **Server Components** mint a short-lived HS256 service token from the session and
  call the API directly with `Authorization: Bearer …`.
- **Browser** calls go to the same-origin **BFF proxy** (`/api/sms/*`), which injects
  the Bearer server-side — the browser never holds a verifiable API token.
- **API** verifies the JWT on every request, then enforces permission → tenant → RLS.

## Integration TODOs (placeholders to replace)
- `apps/api/src/foundation/*` — AuditLog + Consent are dev placeholders; bind the real
  foundation services (`FoundationModule` useClass bindings).
- `packages/db/prisma/schema/_foundation-stubs.prisma` — move the User/School
  back-relations into the real foundation models and delete the stub.
- `apps/web/lib/auth.ts` — replace demo Credentials with the real user lookup / SSO.
- `EMBEDDING_PROVIDER` — bind to enable prose similarity (skipped while unbound).
