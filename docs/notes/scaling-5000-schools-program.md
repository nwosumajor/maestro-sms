# Scaling to 5000 schools program

> Scaling-to-5000-schools program COMPLETE (2026-07-15): all phases merged to main except Phase 7 sharding, intentionally discarded — 5k-school load test proved the single writer idle (11 conns, 0% err); real bottleneck was the entitlement cache TTL, fixed. Sharding is a ~50k concern.

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Goal: run 5000+ schools concurrently (100× the ~50 design target). Compute (ECS/
Redis) scales horizontally and is the easy 80%; the SINGLE shared Postgres writer
is the ceiling — this is a data-tier program.

**Roadmap (data-tier is the battle):**
1. DB read/write split + pooler readiness — **DONE** (merged c568db6)
2. Connection pooling (RDS Proxy + local PgBouncer) — **DONE** (merged d00d555)
3. Pagination/list hardening — **DONE** (merged f4becda)
4. Per-tenant rate limiting (Redis-backed; noisy-neighbor protection) — **DONE** (merged f941936)
5. Partition high-write append tables — **audit_log DONE** (merged b4eff71); same recipe
   still available for notification / integrity telemetry / guess if they ever need it
6. Read-through caching (TenantCache primitive + branding) — **DONE** (merged 6f10059)
7. TENANT SHARDING — **NOT NEEDED at 5,000 schools; do NOT build it on current evidence.**
   Measured at true 5k scale: DB sat IDLE (11 connections, 0% errors) — the writer is not
   the constraint. Sharding would also break the model: every tenant table FKs to the GLOBAL
   school/role tables and Postgres has NO cross-database FKs, so it forces registry
   replication per shard, loss of global user.email uniqueness, and rewriting every
   cross-tenant feature (operator console, platform audit, dunning, scholarship, Ultimate
   arena) as cross-shard fan-outs. Revisit ONLY if a load test shows the writer saturating
   (likely ~50k schools, not 5k).
8. Load-test harness + capacity baseline (seed N synthetic schools, drive concurrency, measure)

**Phase 1 shipped (branch feat/scale-read-write-split → main c568db6):**
- `@sms/db`: new `readPrisma` — read client on `DATABASE_REPLICA_URL` if set, else
  the primary client (single-DB deployments byte-identical, zero risk).
- `TenantDatabase` interface + `PrismaTenantService`: new `runAsTenantReadOnly(ctx,fn)`
  — routes to readPrisma, runs `SET TRANSACTION READ ONLY` (first stmt, before the
  GUC set_config), same tenant GUC + RLS. Read-heavy endpoints opt in incrementally.
- `analytics.overview` is the reference opt-in.
- Terraform: optional `aws_db_instance.replica` (`db_read_replica_count`, default 0) →
  Secrets Manager `db-replica-url` → API task `DATABASE_REPLICA_URL` env; output added.
  `terraform validate` clean.
- KEY FACT (already true, big head start): the tenant GUC is `set_config(..., true)`
  = transaction-local → COMPATIBLE with RDS Proxy / PgBouncer TRANSACTION pooling.
  Most RLS apps use session `SET` and can't pool; this one can.
- Verified: typecheck 13/13, full API suite 612/612 (interface change no regression),
  live proof (DATABASE_REPLICA_URL set → analytics routes through the read-only replica
  path, RLS + role-scope hold: staff→school, parent→family), terraform validate.

**To adopt the read path elsewhere:** change a service's read-only `runAsTenant` →
`runAsTenantReadOnly` (analytics/reports/directory/leaderboards/list GETs). NEVER
for write paths. See [real-foundation](real-foundation.md) for the tenant runner.

**VOLUME testing — BLOCKED on hardware, needs real staging (2026-07-15).** Attempted
1000 schools × 200 students × 30d (~6M attendance rows) on the laptop docker PG. Learned:
- History seeding is generated SERVER-SIDE (`seedHistoryInDb`, INSERT…SELECT over
  generate_series) — millions of rows must never be materialised in Node. Now BATCHED by
  100 schools (a single 6M-row INSERT ran >9min with no progress + WAL blowout; merged 5caaa32).
- **Bulk DELETE of synthetic users is brutally slow**: ~100 tables FK-reference `user.id`, so
  Postgres runs a referential check per referencing table per row → ~20M checks for 202k users
  (>8 min, still running). Only a TEST-CLEANUP cost (the app never hard-deletes users), but it
  makes big local volume runs impractical. Use small `--schools` locally, or run volume tests
  against disposable staging infra where you can drop the DB.
- CONCLUSION: laptop hardware can't seed/clean 20k-school-scale data in reasonable time. The
  volume question (does query cost hold as tables reach 10M+ rows?) needs a real RDS staging
  run. The harness is READY for it — it's now a config change, not new code.

**WORKLOAD mode + register N+1 fix — shipped** (merged bfbcc11):
- `loadtest.mjs --students N` = WORKLOAD mode: seeds a REAL school per tenant (teacher +
  students **with the student ROLE** so the roster query is real, classes, enrollments, N
  days of attendance history, invoices) and `--write-pct P` adds real WRITES (take-register).
  Two identities per school (teacher vs school_admin) so relationship scoping is exercised.
  `--students 0` keeps the old OVERHEAD mode (empty tenants, read-only) so old baselines compare.
  GOTCHA: the API enforces "only students ENROLLED in this class may be marked" → the write
  body must use that class's own roster (`classStudents`), not any student.
- **FOUND + FIXED a real N+1 in the highest-volume write in the product**:
  `AttendanceService.markAttendance` wrote the register with a per-student `upsert` IN A LOOP
  = one round-trip PER STUDENT (40-pupil class = 40 sequential round-trips) with the tenant
  tx held open — every class, every day. Replaced with ONE
  `INSERT … ON CONFLICT ("sessionId","studentId") DO UPDATE` (the existing @@unique makes it
  exactly equivalent; RLS INSERT/UPDATE policies still apply).
  MEASURED (300 schools × 60 students × 20d, 23% writes): write p50 **228.9→143.5ms (-37%)**,
  throughput **297→417 req/s (+40%)** — EVERY endpoint improved because the write no longer
  hogged transaction time. 0% errors, DB still 11 connections.
- NOTE: the attendance unit spec MOCKS `$executeRaw`, so it canNOT prove the raw SQL. Correctness
  was proven against real Postgres (exact statuses persisted; 164 repeated writes → ZERO
  duplicate (session,student) rows). Any future raw-SQL change needs the same live check.

**Phase 8 shipped — load-test / capacity harness** (branch feat/scale-loadtest-harness):
`apps/api/scripts/loadtest.mjs` (also `pnpm --filter @sms/api loadtest`). Self-contained
(pg + jsonwebtoken + fetch, no new deps), NON-DESTRUCTIVE (tags every row
`loadtest-<runId>-…`, cleans up on exit unless `--keep`). Seeds N synthetic tenants
(school + bare ENTERPRISE subscription + users), mints staff JWTs directly (bypasses
login rate-limit), warmup-filters endpoints, drives C concurrent workers for D seconds
across a weighted READ mix (/health, /analytics/overview [replica path], /notifications,
/classes/mine, /students), reports per-endpoint p50/p95/p99 + throughput + error% +
PEAK DB CONNECTIONS. Run:
`AUTH_SECRET=<api's> LOADTEST_ADMIN_URL=postgres://postgres:<pw>@localhost:5433/sms \
  node apps/api/scripts/loadtest.mjs --schools 20 --users 5 --concurrency 50 --duration 15`
(local API AUTH_SECRET = `dev-secret-verify-please-change`; superuser pw `change-me-superuser`).

**BASELINE (2026-07-14, local docker Postgres, single-DB):**
- 30 concurrency: all endpoints ~39ms p50, 814 req/s, 0% err.
- 50 concurrency: list endpoints climb to ~84ms p50 (analytics stays ~39ms), 770 req/s, 0% err.
- **Peak DB connections pinned at 19 at BOTH levels** ⇒ the app is CONNECTION-POOL-BOUND
  (~19 = Prisma default pool). Above the pool size, requests queue → latency doubles.
  This is the direct empirical case for Phase 2 (RDS Proxy pooling) + more replicas, and
  a candidate to move the list endpoints (notifications/classes/students) onto the
  read-only replica path (Phase 1 adoption). Re-run this harness after each phase to prove impact.

**Phase 2 shipped — connection pooling** (branch feat/scale-connection-pooling → d00d555):
- Terraform `infrastructure/terraform/rds_proxy.tf`: `aws_db_proxy` pooler + own SG
  (API→proxy→RDS) + IAM role scoped to a {username,password} creds secret + transaction
  pool config. Gated `var.enable_rds_proxy` (default false). When ON, `db_app_url` routes
  through the proxy with `?pgbouncer=true`; MIGRATE URL always stays DIRECT to the writer
  (DDL/advisory locks need a real session). Proxy endpoint output added. validate+fmt clean.
- Local parity: opt-in `pgbouncer` service in docker-compose under `profiles: [pooler]`
  (transaction mode, edoburu image); backend DATABASE_URL is now an env override so
  `DATABASE_URL=…@pgbouncer:6432/sms?pgbouncer=true` in infrastructure/.env routes through
  it. Default `docker compose up` unchanged.
- PROVEN locally (host PgBouncer 1.25, transaction mode, default_pool_size=10, against the
  docker Postgres): (1) RLS e2e **141/141 GREEN through the pooler** incl. coverage gate +
  "missing GUC fails closed" → isolation holds under transaction pooling. (2) A 2nd API
  instance on `?pgbouncer=true` served the harness at **0.00% errors** (no prepared-stmt
  breakage); `SHOW POOLS` mid-load: ~18 client conns → **exactly 10 server conns**
  (pool_mode=transaction). Server count capped, decoupled from load.
- HOW TO REPRODUCE THE PROOF: install pgbouncer (apt; systemd auto-starts a DEFAULT
  instance on 6432 — `systemctl stop/disable pgbouncer` first), write a .ini pointing at
  127.0.0.1:5433 pool_mode=transaction, userlist from `SELECT rolpassword FROM pg_authid`
  (SCRAM verifier). RLS proof = run `npx jest test/rls.e2e-spec.ts` with
  TEST_DATABASE_URL→:6432, TEST_ADMIN_URL→direct :5433 superuser.

**Phase 3 shipped — list hardening** (branch feat/scale-list-pagination → f4becda):
- `@sms/types` `packages/types/src/pagination.ts`: `LIST_CAP=500` + `SEARCH_CAP=50`
  (one source of truth for list limits).
- Capped the genuinely unbounded SCHOOL-WIDE time-growing interactive lists to the
  most-recent page: `workflow.listRequests`, `assessment.listAssessments`,
  `leave.listRequestsWhere`. Most `findMany` were already bounded (parent-scoped) or
  capped (notifications take:100, documents/fees take:200, messaging 500).
- `lms.listStudents(p, q?)`: optional `?q=` server-side name filter + SEARCH_CAP for
  large-school people-pickers. **no-q whole-school path stays UNCAPPED on purpose** —
  admin dashboard derives student count from it (capping would undercount). Deeper
  paging = keyset-cursor follow-up (audit viewer is the ref pattern).
- Read-path adoption (Phase 1): those 4 pure reads moved to `runAsTenantReadOnly`.
- GOTCHA when running the full API jest suite locally: service e2e need `DATABASE_URL`
  (+ `DATABASE_MIGRATE_URL` for billing/subscription privileged paths) set, not just
  `TEST_DATABASE_URL`/`TEST_ADMIN_URL` (those only feed the raw-pool RLS e2e). With all
  set: **612/612 green**. typecheck 13/13.

**Phase 4 shipped — per-tenant rate limiting** (branch feat/scale-tenant-rate-limit → f941936):
- `apps/api/src/common/tenant-rate-limit.service.ts`: Redis fixed-window counter keyed
  `rl:tenant:{schoolId}:{minuteBucket}`, atomic INCR+expire-on-first via Lua eval. Budget
  SHARED across all ECS tasks (true tenant aggregate). Default 1200/min
  (`TENANT_RATE_LIMIT_PER_MIN`); `TENANT_RATE_LIMIT_DISABLED=true` off. Own ioredis client
  (same config pattern as RedisPubSubService), `enableOfflineQueue:false`.
- Enforced INSIDE `PermissionGuard.canActivate` right after `req.principal` is set, BEFORE
  the module/permission DB work (flooding tenant rejected cheaply). Sets X-RateLimit-* headers
  always; 429 + Retry-After on breach. `@Public`/webhook routes bypass (guard short-circuits).
- **FAIL-OPEN**: any Redis error → allowed (a limiter outage must never take down the API).
- Constructor of PermissionGuard gained a 5th arg → `test/auth/module-guard.spec.ts` updated
  (added getResponse stub + rate mock) + a 429-branch test. `TenantRateLimitService` provided
  in FoundationModule (@Global).
- PROVEN: unit suite (allow-until-limit / per-tenant isolation / fail-open / disabled no-op)
  + live noisy-neighbor proof (2nd API instance, cap 50/min): school A flooded 80 reqs →
  **exactly 50 allowed / 30×429**, school B's 10 reqs ALL passed. Full API suite **617/617**.

**Phase 6 shipped — read-through caching** (branch feat/scale-read-through-cache → 6f10059):
- `apps/api/src/common/tenant-cache.ts` — reusable `TenantCache<T>(name, ttlMs, pubsub?)`:
  per-key process-local TTL cache + cross-instance invalidation via RedisPubSubService
  (channel `cache:<name>`; write on one task drops stale copy on ALL). LRU-evict past 10k
  keys. No Redis ⇒ plain per-process TTL cache. Extracted from the ModuleEntitlementService
  pattern (that service left as-is — didn't refactor a working every-request path).
  **NOT for authorization/scoping data** (enrollment/roles/grants) — staleness = security risk.
- Applied to `BrandingService`: `getMemberBranding` (key schoolId) + `getPublicBranding` (key
  slug), 60s TTL, hit on nearly every page load. Logo/theme writes invalidate both keys.
  CORRECTNESS: cache holds DB-derived data only; the presigned logo URL is re-signed OUTSIDE
  the cache each call so a short-lived signed URL is never served stale.
- Verified: 5 unit tests + full suite **622/622** (live PG+Redis), typecheck clean.
- NEXT adoption target for the primitive: per-school GameSettings (read per game op across 7
  services via `effectiveGameSettings(tx.gameSettings.findFirst(...))`).

**Phase 5 shipped — audit_log partitioned by month** (branch feat/scale-audit-partition → b4eff71):
- Migration `20260824000000_audit_log_partition` converts audit_log to RANGE partitioning on
  `createdAt`. PK is now COMPOSITE `@@id([id, createdAt])` (PG forces the partition key into
  every PK) — safe: audit_log is only ever findMany/create, never findUnique/update/delete.
- **THREE traps that will recur if partitioning another table:**
  1. `FORCE ROW LEVEL SECURITY` applies to the table OWNER too; the migrate role is NOT a
     superuser on RDS → the data-copy SELECT silently returns ZERO rows. Must DISABLE RLS on
     the old table before copying + assert row counts (the migration RAISEs on mismatch).
  2. Index names are schema-GLOBAL → rename the old table's indexes aside before the new
     table claims `audit_log_pkey` etc.
  3. `docker-entrypoint.sh` applies each rls/*.sql keyed on that file's LAST policy as a
     sentinel. audit_log's policies live in `02_foundation_rls.sql` whose sentinel is ANOTHER
     table's policy → after a table swap the file is SKIPPED and the table returns with NO
     RLS. The migration must recreate policies + grants itself.
- `ensure_audit_log_partition(date)` — idempotent partition factory IN THE DB (shape + RLS
  defined once). Every partition gets its OWN RLS (defence in depth); partitions get NO
  grants (app only queries the parent). A DEFAULT partition means an INSERT can never fail.
- `apps/api/src/maintenance/` — daily BullMQ sweep (mirrors retention/dunning; privileged
  client; no-op when unconfigured) pre-creates next 3 months + alarms if DEFAULT is non-empty.
- **Keyset cursors must carry the composite key**: `apps/api/src/common/audit-cursor.ts`
  encodes `<createdAt ISO>_<uuid>` into the SAME opaque string (wire contract unchanged);
  legacy bare-id token → null → restart page 1. Applied to security audit viewer + operator
  platform audit (their Prisma `cursor` now needs `{id_createdAt:{...}}`).
- RLS coverage gate updated: include relkind 'p' (partitioned parents can't escape the gate)
  + exclude `relispartition` (partition names roll monthly).
- NO retention/drop policy added — audit logs are NDPR compliance records; that's a policy call.
- Verified live: 1112/1112 rows preserved, relkind=p + RLS on, rows routed to audit_log_2026_07,
  DEFAULT empty, grants INSERT/SELECT-only, bogus GUC sees 0/1112, live app write landed 1113
  in the right partition, factory idempotent. Suite **627/627**, typecheck 13/13.

**5,000-SCHOOL VALIDATION — the program's conclusion (2026-07-15, merged 3f1d4f5):**
Seeded 5,000 real synthetic tenants and drove load. Findings:
- **The data tier is NOT the constraint at 5k.** 77,251 reqs, 0.00% errors, **11 DB
  connections**, DB idle. The single writer never broke a sweat ⇒ Phase 7 sharding solves a
  problem that does not exist. (My earlier "5k needs sharding" was a GUESS; the harness killed it.)
- **The real bottleneck was `ModuleEntitlementService`** (PermissionGuard hits it on ~every
  request). Process-local TTL cache ⇒ **misses/sec = tenants / TTL, independent of traffic**.
  At 30s TTL × 5k tenants = ~167 reloads/sec, each a full interactive tx (BEGIN + 2×set_config
  + SELECT + COMMIT ≈ 5 round-trips). Diagnosis tell: module-gated endpoints degraded 4×
  (39→162ms) while the ALWAYS-ON endpoint was flat (84→86ms). At 20 tenants it missed 0.09% —
  which is why it never surfaced. **Any per-request per-tenant cache has this tenant-count
  scaling property — check TTL vs tenant count before adding one.**
- FIX: TTL 30s → 10min (safe: writes invalidate cross-task via Redis pub/sub; TTL only
  backstops a pubsub outage; module gating is a BILLING gate, fails toward the purchased
  plan) + 20k-entry bound. Result at 5k warm: analytics 162→**88.9ms** ≈ always-on 78.6ms;
  throughput 476→**644 req/s** from ONE laptop instance co-located with PG+Redis+load-gen.
- **BEWARE the harness's access pattern**: uniform-random spray over 5k tenants in a SHORT run
  never warms a per-tenant cache (each school hit ~2×/20s) — that's a COLD-cache artifact, not
  steady state. Use `--duration 120` for 5k-tenant runs; short runs understate real performance.
- CAPACITY: remaining ~80ms p50 is per-request app work, which scales HORIZONTALLY (ECS tasks).
  644 req/s/instance on a laptop; real Fargate is higher. 5k schools ⇒ scale API tasks, not shards.

Staging (now MEASURED, not guessed): pooling + replicas + partitioning + entitlement-cache fix
carry 5,000 schools with the DB idle. Sharding is a ~50k-school concern.
