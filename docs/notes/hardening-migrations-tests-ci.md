# Hardening: migrations/tests/CI

> Hardening pass — tracked migrations, committed RLS/relationship tests, and CI pipeline (all verified)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Consolidation/hardening pass after foundation + LMS (all verified by simulating the full CI flow locally):

1. **Tracked migrations** (replaced `db push`): RLS SQL MOVED out of prisma/migrations into `packages/db/prisma/rls/{01_integrity,02_foundation,03_lms}_rls.sql` (so Prisma doesn't choke on the major_user grant in its shadow DB). `prisma migrate dev --name init` created the tracked tables migration (`prisma/migrations/<ts>_init`). Deploy flow = `prisma migrate deploy` → `pnpm --filter @sms/db rls` (applies prisma/rls/*.sql in order via $DATABASE_MIGRATE_URL) → `prisma db seed`. Added `setup` script that chains them. RLS stays SEPARATE from Prisma migrations (CLAUDE.md intent).

2. **Committed RLS + relationship tests** (run against real Postgres, no longer skipped):
   - `apps/api/test/rls.e2e-spec.ts` — consolidated; uses TWO pools: TEST_ADMIN_URL (superuser, seeds across FKs) + TEST_DATABASE_URL (app role major_user, RLS enforced for assertions). Covers cross-tenant SELECT isolation (user/class/assessment/submission), append-only (audit_log + integrity_signal), WITH CHECK foreign-schoolId rejection, fail-closed missing GUC. Deleted the old broken `test/integrity/rls.e2e-spec.ts` (it inserted assessment with a random schoolId that violates the real School FK).
   - `apps/api/test/lms/lms.service.spec.ts` — relationship-scoping unit test (teacher/student/parent/admin/non-member + roster 404). Total api tests now 34, web 4.
   - GOTCHAS hit + fixed: raw inserts must supply `updatedAt` (Prisma @updatedAt is app-side, no DB default); `user` is a SQL reserved word (quote it: `FROM "user"`); fail-closed can be 0-rows (unset GUC→NULL) OR a cast error (empty-string GUC→''::uuid) on pooled connections — assert "not visible" either way.

3. **CI** (`.github/workflows/ci.yml`): postgres:16 + redis:7 services, create least-priv major_user role, generate, migrate deploy, apply rls, typecheck, test (TEST_DATABASE_URL=app role, TEST_ADMIN_URL=admin), build. KEY FIX: turbo 2.x defaults to STRICT env mode, so the test task needs `passThroughEnv: [TEST_DATABASE_URL, TEST_ADMIN_URL, AUTH_SECRET, REDIS_HOST, DATABASE_URL]` in turbo.json — without it the RLS e2e was silently SKIPPED.

VERIFIED: full CI sequence run locally on a fresh db → migrate deploy + rls + typecheck (8/8) + test (38 total incl. e2e) + build (5/5) all green. sms_ci scratch db dropped; sms_verify kept.

STILL FOR PRODUCTION: secrets manager, remove guard x-dev-principal bypass, retention/purge job, Dockerfiles + Terraform (AWS), observability; more product modules (gradebook next — unblocked by LMS).
