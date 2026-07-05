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
- Node 20+, pnpm 9, PostgreSQL 14+, Redis 6+.

## First-time setup
```bash
pnpm install

# env: copy and fill the examples (keep AUTH_SECRET identical in web + api)
cp apps/api/.env.example       apps/api/.env
cp apps/web/.env.example        apps/web/.env
cp packages/db/.env.example     packages/db/.env

# database
pnpm db:generate                          # prisma client
pnpm --filter @sms/db migrate             # tables (as the app/migrate role)
pnpm --filter @sms/db rls                 # apply RLS policies (privileged role)
```

> RLS is applied SEPARATELY from the Prisma migration, on purpose (CLAUDE.md).
> Tables run as the privileged role; the app connects as `major_user`.

## Run (dev)
```bash
pnpm dev          # turbo: web on :3000, api on :3001
```
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
