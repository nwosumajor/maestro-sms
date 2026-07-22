# Real foundation

> The placeholder foundation was replaced with a real, DB-backed one (auth, RBAC, audit, consent) and verified

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Replaced the dev-stub foundation with a REAL one (verified end-to-end against Postgres):
- **Models** (`packages/db/prisma/schema/foundation.prisma`, replaced `_foundation-stubs.prisma`): `School`(global), `User`(tenant, email-unique, bcrypt passwordHash), `Role`/`Permission`/`RolePermission`(global RBAC), `UserRole`(tenant), `AuditLog`(tenant, append-only), `IntegrityConsent`(tenant). Integrity back-relations wired in.
- **RLS** (`packages/db/prisma/migrations/20260618_foundation_rls/migration.sql`): RLS on user/user_role/audit_log/integrity_consent (fail-closed, same pattern); audit_log append-only; SELECT grants on global tables; + `app_login_lookup(email)` SECURITY DEFINER function (lets the least-priv app role find a user across tenants for login WITHOUT RLS leaking other schools).
- **Real services** (`apps/api/src/foundation/`): `AuditLogService` → `tx.auditLog.create` (durable); `ConsentService` → reads `integrity_consent` via tx (changed the `ConsentService.hasIntegrityConsent(args, tx)` contract — call sites in integrity.service.ts updated); `AuthService`+`AuthController` (`POST /auth/login`, @Public) = SECURITY-DEFINER lookup + bcrypt + RBAC resolution; bound in `FoundationModule`.
- **Web auth** (`apps/web/lib/auth.ts`): NextAuth Credentials now calls `POST /auth/login` (no hardcoded users).
- **Seed** (`packages/db/prisma/seed.ts`, `prisma db seed` via tsx): school "demo", 8 perms, roles teacher/student/school_admin, users teacher@demo.school & student@demo.school (pw `password123`), consent for student, assessment 3333.

VERIFIED: real login resolves roles/permissions from DB; wrong password→401; JWT→/take→200 with consentGranted read from integrity_consent; durable audit row written to audit_log table. Typecheck 8/8.

Deps added: `bcryptjs`+`@types/bcryptjs` (api runtime, db seed dev), `tsx` (db seed). `TenantTx` interface extended with user/userRole/auditLog/integrityConsent/school.

STILL FOR PRODUCTION (not done): tracked Prisma migrations (still using `db push`), secrets manager (dev `.env.local`), retention/purge job, remove guard `x-dev-principal` bypass, the deferred product modules (LMS/gradebook/etc.), CI + Dockerfiles + Terraform. sms_verify DB is currently up with the real schema+seed for `pnpm dev`.
