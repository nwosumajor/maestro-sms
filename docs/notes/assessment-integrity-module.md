# Assessment Integrity module

> Status and key design decisions for the Assessment Integrity module build

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Built the full Assessment Integrity module (CLAUDE.md spec) in 5 reviewed steps: data model (`packages/db`), client capture (`apps/web/lib/integrity`), server detectors + BullMQ worker (`apps/api/src/integrity`), teacher report view, and tests (`apps/api/test/integrity`, `apps/web/lib/integrity/__tests__`).

Non-obvious decisions awaiting/confirmed by the user:
- **Foundation code is NOT in this checkout** (only CLAUDE.md was present). Everything was written ADDITIVELY: new tables reference `School`/`User`/`AuditLog` via scalar `@db.Uuid` FKs (no foundation models edited); foundation deps (tenant-scoped Prisma runner, `@RequirePermission`, `CurrentTenant`/`CurrentPrincipal`, `AuditLogService`, NDPR `ConsentService`) referenced by contract in `integrity.foundation.ts`.
- **`SubmissionTelemetry` table (ACCEPTED by user)**: append-only, tenant-scoped, holds raw client `TYPING_CADENCE` samples. Reason: client must never write a `TYPING_ANOMALY` (GR#8), and cadence is raw telemetry feeding the server detector, not a reviewed signal. `PASTE`/`FOCUS_LOSS` remain real CLIENT `IntegritySignal`s.
- **App DB role is `major_user`** (confirmed by user) — used in all RLS GRANT/REVOKE in `packages/db/prisma/migrations/20260618_integrity_rls/migration.sql`.
- **Exempt students get NEITHER friction NOR surveillance** (stronger than literal spec "skip friction") — instrumenting an accommodation is discriminatory; flagged to user.
- RLS test suite needs `TEST_DATABASE_URL` (app role, migration applied); `describe.skip`s if unset.

Prisma User/School back-relations are STUBBED in `packages/db/prisma/schema/_foundation-stubs.prisma` (named relations: AssessmentCreatedBy, SubmissionStudent, ExemptionStudent/Granted/Revoked). AT INTEGRATION: move those relation fields into the real foundation User/School models and DELETE the stub file (one User, one School). FK `@@map` names assumed: `user`, `school`.

Retention purge (GR#5) for append-only tables is a separate privileged scheduled job — interface sketched in the RLS migration, NOT implemented.
