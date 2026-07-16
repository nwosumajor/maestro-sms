# CLAUDE.md — School Management System (SMS)

## What this is
A multi-tenant, enterprise School Management System serving up to ~50 schools
concurrently from one deployment. Each school (tenant) gets: an LMS for students,
monitoring dashboards for teachers, a parent monitoring dashboard, and a
BPMN-style approval engine. Security posture: least-privilege access control and
defense in depth throughout.

This file is durable project context. Follow it on every task. If a request
conflicts with it, flag the conflict before proceeding.

## Golden rules (non-negotiable)
1. EVERY tenant-scoped table has a non-null `school_id`. No exceptions.
2. Tenant isolation is enforced at THREE layers: JWT claim → NestJS guard →
   Postgres Row-Level Security. Never rely on a single layer.
3. Never trust `school_id` from the request body or query params. It comes only
   from the verified JWT, set into the DB session, and enforced by RLS.
4. Least privilege everywhere: the app DB role cannot DROP/ALTER/TRUNCATE;
   migrations run under a separate privileged role. No wildcard permissions.
5. Minors' data (student records, AND behavioral/integrity telemetry) is
   sensitive. All reads/writes to student PII and all integrity events are
   audit-logged. Apply NDPR-aligned consent and retention rules.
6. No secrets in code or committed env files. Use env vars / secrets manager.
7. When unsure about a security or multi-tenancy decision, choose the more
   restrictive option and leave a `// SECURITY:` comment explaining why.
8. No automated punitive action against a student. Integrity tooling produces
   SIGNALS for human review only — never a verdict, score penalty, or record
   entry on its own.

## Stack
- Frontend (web): Next.js (App Router) + TypeScript, Server Components,
  TanStack Query, Tailwind + shadcn/ui.
- Design system: a small fixed set of design tokens (color, spacing, type,
  radius) drives all UI and enables per-tenant theming via theme swap, not
  per-school redesigns. AI tools (Google AI Studio / Stitch / v0) may be used to
  EXPLORE visual direction, but shipped UI is rebuilt in shadcn/ui + tokens.
  Generated one-off screens are never the foundation.
- Mobile (later): React Native (Expo), sharing types via a shared package.
- Auth: Auth.js (NextAuth) in the Next.js layer. It owns login + session and
  issues a signed JWT containing `userId`, `school_id`, `roles`, `permissions`.
- Backend API: NestJS + TypeScript. Stateless. VERIFIES the JWT on every
  request; never issues sessions itself.
- ORM: Prisma. RLS is enforced at the Postgres layer, NOT only via Prisma.
- DB: PostgreSQL with Row-Level Security. Redis for cache/rate-limit/queues.
- Storage: S3 / Cloudflare R2 for files (report cards, assignments). Never
  store files in Postgres.
- Async: BullMQ (Redis) for notifications, report generation, AND integrity
  detection jobs.
- Approval engine: BUILT as an internal Postgres state machine (deterministic
  transitions + an immutable WorkflowAuditLog), NOT Temporal/Camunda. See
  `apps/api/src/workflow`.
- DB content: flexible/unstructured data (LMS course/quiz/forum content) lives in
  Postgres JSONB, NOT MongoDB — one DB keeps the RLS tenant-isolation model intact.
- Infra: Docker + docker-compose for local orchestration (`infrastructure/`).
  Target cloud: ECS Fargate, Terraform, GitHub Actions OIDC, CloudFront + WAF,
  ALB, private subnets, NAT. Write container-ready code.

## Multi-tenancy model
- Shared schema + Postgres Row-Level Security (RLS). One `school_id` column on
  every tenant-scoped table. This scales smoothly past 50 tenants.
- App opens each request transaction with `SET LOCAL app.current_school_id` (and
  `app.current_user_id`) so RLS policies can read them via
  `current_setting('app.current_school_id')`.
- RLS policies: `USING (school_id = current_setting('app.current_school_id')::uuid)`
  on SELECT/UPDATE/DELETE, plus a matching `WITH CHECK` on INSERT/UPDATE.
- Global (non-tenant) tables — the `School` registry, system roles/permissions —
  are explicitly marked and RLS-exempt. List them; never leave it implicit.

## RBAC model (custom, data-driven)
- Roles live in DB tables (`Role`/`Permission`/`RolePermission`/`UserRole`),
  seeded in `packages/db/prisma/seed.ts`: super_admin (cross-tenant), board
  (read-only oversight + workflow veto), principal, school_admin, teacher,
  student, parent, accountant, hr_clerk, hr_manager (owns leave/salary/payroll +
  stage-2 approver), head_teacher / head_admin (stage-1 approvers for the staff-
  request chain), warden (their own hostel), driver (read-only own vehicle),
  head_warden (EVERY hostel), head_driver (whole fleet), librarian (library
  module) — 17 roles total. All except super_admin are scoped to a single
  `school_id`.
  Adding a role/permission is a seed change, not new code.
- Permissions are fine-grained strings (e.g. `student.read`, `grade.write`,
  `workflow.review`, `integrity.report.read`) in `packages/types/src/permissions`.
- Authorization is checked in NestJS via `@RequirePermission('grade.write')` +
  the global PermissionGuard, AND backstopped by RLS at the DB.
- Relationship scoping beyond role IS IMPLEMENTED (LmsService is the reference):
  teacher→their classes, student→enrolled, parent→their children. Coarse
  permission gates the endpoint; membership joins narrow the rows; RLS backstops.

## Subscription / module entitlements (platform billing layer) — BUILT
- A SECOND, orthogonal gate above RBAC: which product MODULES a school's
  subscription enables. super_admin-owned (schools can't self-upgrade). Source of
  truth in `@sms/types/modules.ts`: `MODULES` keys, `MODULE_CATALOG`, named tiers
  `PLANS` (STANDARD|PREMIUM|ULTIMATE|ENTERPRISE) → `PLAN_MODULES` bundles, `ModuleOverrides`
  (per-school force-on/off), and the pure `resolveModules(plan, overrides)`.
- Storage: `SchoolSubscription` (tenant-scoped, RLS `22_subscription_rls.sql`,
  migration `20260629000000_subscription`) — `plan` + `overrides` JSON, one row per
  school. NO row ⇒ `DEFAULT_PLAN` = the **STANDARD floor (fail-closed)** — a data
  gap under-provisions to core teaching, never gives away the full suite. Every
  school gets an explicit row: onboarding stamps `currentPeriodEnd = now +
  SUBSCRIPTION_TRIAL_DAYS(30)` so dunning eventually fires; the seed writes an
  ENTERPRISE row for the demo. Backfill rows for row-less schools before
  deploying the fail-closed default onto an existing DB. **Tier PRICING is
  operator-set**: global RLS-exempt `plan_price` (migration `20260726000000`,
  `rls/46` — app role SELECT-only; writes via the privileged client);
  `PlanPricingService.effective()` merges rows over the `PLAN_PRICING` defaults
  (60s cache) and feeds quotes, checkout, and PUBLIC `GET /public/plan-pricing`
  (the landing page derives prices from it — marketing can't drift from the
  bill). `GET/PUT /operator/pricing` (`platform.operate`; PUT step-up +
  audited). An **AppShell renewal banner** (light `GET /billing/status`) nudges
  `billing.read` staff at ≤14 days / expired / PAST_DUE. The parent-fees
  Paystack webhook is **idempotent on the gateway reference** (a retried
  charge.success can't double-credit an invoice).
- Enforcement: controllers carry `@RequireModule(MODULES.X)` (class-level);
  `PermissionGuard` resolves the school's effective modules via
  `ModuleEntitlementService` (foundation, 30s cache; invalidation fans across ECS
  tasks via `RedisPubSubService` — see Live push) and returns **404** if the
  module is off — orthogonal to `@RequirePermission`, before the permission check.
  ALWAYS-ON (untagged) controllers: foundation/auth, security, privacy,
  notifications, admin dashboard, operator, **billing**. The public `/apply` intake
  is `@Public` so it bypasses the gate regardless of the admissions module.
- super_admin surface: `GET/PUT /operator/tenants/:schoolId/subscription`
  (`platform.operate`, audited; cache invalidated on write). Web: `/operator`
  shows each tenant's plan + a `SubscriptionManager` (tier select + per-module
  toggles); the AppShell nav hides modules not in the plan (modules ride the JWT
  session, set at login from `/auth/login`). Adding a module = a key in
  `@sms/types` + `@RequireModule` on its controller + a nav `module:` tag.
- **Self-serve BILLING ENGINE — BUILT** (`apps/api/src/billing`, `apps/web/.../billing`):
  turns the entitlement gate into recurring revenue. A school's principal/
  school_admin self-checks-out a tier (`@RequireStepUp`) at `/billing`; pricing is
  **per-seat** (active students × tier monthly rate × cycle months — pure
  `computeSubscriptionPriceMinor` in `@sms/types`), money in integer kobo. Paystack
  is reused via a shared `PaystackService` (`apps/api/src/payments`); the ONE
  account-wide webhook stays on the `@Public` fees route and is dispatched by
  `metadata.kind` (`"subscription"` → `BillingService.applySubscriptionPayment`,
  one-way dep fees→billing). A paid webhook EXTENDS `currentPeriodEnd` (renewals
  stack) and sets status ACTIVE. `SchoolSubscription` gained `status`/`billingCycle`/
  `currentPeriodEnd`/`seats`/`priceMinor`; new append-only tenant table
  `PlatformSubscriptionPayment` (RLS `24_subscription_billing_rls.sql`, migration
  `20260701000000_subscription_billing`, no hard-delete). **Delinquency is
  status-driven, never destructive:** the purchased `plan` is never overwritten —
  `ModuleEntitlementService` resolves modules against a computed `effectivePlan`
  (pure; BASIC once PAST_DUE beyond `SUBSCRIPTION_GRACE_DAYS`), so paying restores
  access instantly. A privileged cross-tenant **dunning sweep** (`BillingDunningService`,
  mirrors the retention job: BullMQ daily + manual `POST /billing/dunning/run` for
  `billing.dunning.run`/super_admin; reuses the `DATABASE_RETENTION_URL`→`MIGRATE_URL`
  client) flips elapsed ACTIVE subs to PAST_DUE + sends renewal reminders.
  super_admin keeps override/comp via the operator PUT (now also accepts
  `status`/`currentPeriodEnd`). Perms `billing.read`/`billing.manage`/`billing.dunning.run`
  seeded. **REFERRAL PROGRAM — BUILT** (growth loop on this engine): a school
  generates a shareable code (`GET/POST /billing/referral*`, panel on `/billing`);
  the public `/onboard?ref=` form carries it; PRIVILEGED provisioning resolves it
  onto the new school's `SchoolSubscription.referredBySchoolId`; the webhook's
  FIRST paid subscription grants BOTH sides one free term (`REFERRAL_REWARD_MONTHS`
  = CYCLE_MONTHS.TERM = 3) — atomically in the payment tx (tx-local GUC switch in
  `ReferralService.grantRewardsInTx`, the ONE billing tenant-boundary crossing),
  idempotent twice over (`referralRewardAt` claim + UNIQUE `referredSchoolId` on
  the append-only `school_referral_conversion` ledger). Tables owned by the
  REFERRER (RLS `70_referral_rls.sql`, migration `20260828000000_referral`); both
  sides audited + notified; conversions listed on `/billing`, referral chip on the
  operator's onboarding review. Verified: 8 pure pricing/effective-plan unit tests + DB-gated
  `billing.service.e2e` (checkout-503 / webhook apply+extend+idempotency / dunning→
  PAST_DUE→effective-BASIC) + an RLS cross-tenant case on the new payment table.

## Project structure
- Monorepo (Turborepo + pnpm workspaces).
  - `apps/web` — Next.js + Auth.js
  - `apps/api` — NestJS; modules: `foundation` (auth/RBAC/audit/consent/tenant-db
    runner), `integrity`, `lms`, `gradebook`, `workflow`
  - `packages/types` — shared TS types / DTOs / permission constants. NOTE:
    `apps/api` imports these via the package BARREL (`@sms/types`), not subpaths.
  - `packages/db` — Prisma multi-file schema (`prisma/schema/`), tracked
    migrations (`prisma/migrations/`), and RLS SQL applied SEPARATELY
    (`prisma/rls/*.sql`, ordered) — NOT inside Prisma migrations.
  - `packages/tokens` — design tokens
  - `infrastructure/` — docker-compose, nginx, Postgres init
- DTOs and permission string constants live in `packages/types` as the single
  source of truth across web, api, and (later) mobile.

## Build status
BUILT & verified (RLS-isolated, relationship-scoped, audited, tested, CI-gated):
foundation auth/RBAC/audit/consent, Assessment Integrity (incl. the NDPR
retention/purge job), LMS core (classes / enrollment / teaching / guardians),
Gradebook (manual grading), SIS Contact/Medical (student profile / emergency
contacts / medical record — medical reads AND writes audited), Attendance
(per-class daily register, teacher-of-class scoped, parent/student read),
Notifications (in-app inbox + async BullMQ multi-channel delivery via a pluggable
channel provider; self-scoped reads, relationship-scoped staff send; Attendance
ABSENT/LATE auto-notifies guardians), Fees/Billing (fee catalog + invoices +
payments; integer minor-unit money; DRAFT→ISSUED→PARTIALLY_PAID→PAID lifecycle;
parent→children / student→self / finance-staff→all scoping; issue + full-payment
notify guardians; no hard-delete of financial records), Document Vault (report
cards / receipts / certificates — METADATA in Postgres, bytes in S3/R2 via
presigned upload/download URLs from a pluggable StorageProvider; student /
guardian / teacher / staff scoping; downloads audited; guardians notified on
shareable docs), Timetabling (periods / rooms / weekly lesson grid with
teacher/room/class double-booking conflict detection -> 409; teacher→own /
student→enrolled / parent→children / staff→all scoping; CSP auto-generation is
future), the Approval Workflow Engine, the Docker/Compose orchestration, and a
role-filtered web UI (login + AppShell nav gated by permissions; pages for
Notifications, Students/SIS profile, Classes, Timetable, Attendance incl.
take-register, Fees incl. record-payment, Documents incl. signed download,
Assessments, Approvals — server components via `apiGet`, client islands hit the
BFF). Staff admin/create UIs are built too: an `/admin` overview dashboard
(stats + quick actions, gated by `fee.manage`) plus per-module create/edit forms
— fee items & invoices (+issue/cancel/record-payment), SIS profile/contacts/
medical editing, timetable periods/rooms/conflict-checked lessons, document
upload, announcement send, and class create/assign-teacher/enroll/link-guardian.
A staff-gated `GET /users` and relationship-scoped `GET /students` back the
pickers. Security/access governance is BUILT: a scoped, filterable **audit-log
viewer** (`security.audit.read`) and **Just-In-Time privilege elevation** —
request → approve by a DIFFERENT person (separation of duties) → auto-expire, or
break-glass (self-activated, flagged); the global PermissionGuard consults active
`PrivilegeGrant` rows on a permission MISS and audit-logs the elevated use, so
elevation is additive to the JWT and never long-lived. **SECURITY: elevation
(incl. break-glass) can NEVER grant a platform/cross-tenant or maker-checker
permission** — `NON_ELEVATABLE_PERMISSIONS` / `isElevatable` in `@sms/types`
(platform.operate, billing.manage, billing.dunning.run, rbac.manage,
security.elevation.approve, fee.approve, hr.salary.approve, game.ultimate.admin)
is enforced BOTH at request time (`SecurityService.requestElevation`) and at use
time (`PermissionGuard.hasActiveGrant`), so a teacher can't self-escalate to
super_admin. `/admin/audit` + `/admin/security` UIs. Auth hardening is BUILT: **TOTP MFA** (hand-rolled
RFC-6238 via node crypto — enroll/verify/disable + login challenge; `/account`
setup UI + optional 2FA field on login), **account lockout** (3 failed logins →
PERMANENT lock, super_admin-reactivated via the operator console; a super_admin's
own lock AUTO-EXPIRES after 15 min so the platform owner can never be locked out
by an attacker who merely knows their email; counters on the user row, committed
even when the login throws), a **30-day forced password reset** (super_admin
exempt; `passwordChangedAt=null` ⇒ change forced at next login), a **rate-limited
login** (`RateLimitGuard` 10/min per IP on POST /auth/login — the in-process
backstop to the edge WAF), and
**step-up re-auth** (`POST /security/stepup` mints a 5-min token; `@RequireStepUp`
+ guard enforce it — applied to medical edits and MFA-disable; BFF forwards the
`x-stepup` header). **Maker-checker on money** (large payments ≥ ₦50k and ALL
refunds post as PENDING_APPROVAL and don't move the balance until a DIFFERENT
staff member with `fee.approve` approves; separation of duties enforced),
**field-level PII encryption** (medical fields AES-256-GCM with a per-tenant HKDF
key from `DATA_ENCRYPTION_KEY` — ciphertext at rest, decrypted only for
authorized readers), and an **access-recertification report** + anomaly signals
(`/admin/recertification`) are BUILT. Cross-cutting BUILT so far: **role-scoped
analytics** (`/analytics` — attendance %, fee collection, ops counts; school-wide
for staff, family-scoped for parents/students) and **NDPR data-subject rights**
(`privacy.*`: scoped + audited data export bundle, and a governed right-to-erasure
request → controller review at `/admin/privacy`). **Two-way messaging**
(participant-scoped threads; non-staff may only message staff/teachers; new
messages notify via Notifications), a **calendar** (`school_event`, ALL vs STAFF
audience), and **report-card PDFs** (pdfkit, from grades + attendance, streamed
through the binary-aware BFF, guardians notified) are BUILT. **Online payments**
are scaffolded (Paystack via `fetch`: `POST /invoices/:id/pay/init` → hosted
checkout; `@Public` HMAC-SHA512-verified webhook → records a POSTED payment on
charge.success; gracefully 503-disabled when `PAYSTACK_SECRET_KEY` is unset —
the disabled/public paths are verified, but live charging needs real creds +
outbound network). #14 (cross-cutting) is DONE. By-role (#15) so far: **HR module**
(`/hr` — staff employment records with field-encrypted salaries; the `hr_clerk`
role's home; `hr.read`/`hr.write`. BOTH reads audited — incl. the list view, which
decrypts every salary — and an upsert records a `created` boolean in the
audit metadata WITHOUT ever writing the plaintext salary. Covered by an
`hr.service.spec` unit suite + the `employee` RLS cross-tenant case),
**tenant-scoped RBAC management** (`/admin/roles` — assign/remove a
user's roles; role→permission defs stay platform-level), and **bulk student
import** (`/admin/import` — CSV→accounts, idempotent on email) are BUILT
(`rbac.manage` + reuses `class.write`). Student/parent self-service is already
covered by the scoped analytics/fees/attendance/documents/messages/notifications
pages.
By-role (#15) is now DONE: **finance reports** (`/fees/reports` — receivables
aging + collection, billing-wide only), the **super_admin operator console**
(`/operator` — cross-tenant registry via per-school GUC; **audited, step-up-gated
impersonation** minting a scoped HS256 token), and the **public admissions portal**
(`/apply` → `@Public` intake quarantined from student data; staff review at
`/admin/admissions`) are all built. The full suggested-functionality program
(security spine + cross-cutting + by-role) is IMPLEMENTED and verified.

**HR maturity + multi-stage approvals + self-serve onboarding — BUILT**
(`apps/api/src/hr`, `apps/api/src/workflow`, `apps/api/src/operator`; migration
`20260627144259_*`, RLS `25_hr_payroll_rls.sql`; web `/leave`, `/hr`, `/hr/payroll`,
`/operator`). (1) The **Approval Workflow Engine is now multi-stage**: a
`WorkflowRequest` carries an ordered `stages` chain + a `currentStage` pointer +
an `approvals` log. An APPROVE advances the pointer (staying PENDING_REVIEW) until
the LAST stage finalizes to APPROVED; each stage's approver must hold that stage's
GRANULAR permission AND must not have acted before (separation of duties — every
stage decided by a different person). Empty `stages` = legacy single-stage (back-
compat). The staff chain `STAFF_REQUEST_CHAIN` (in `@sms/types`) is head
(`workflow.review.head`) → HR manager (`workflow.review.hr`) → principal
(`workflow.review.principal`); types `LEAVE` + `STAFF_REQUEST` auto-route through it.
A one-way `WorkflowHooksService` fan-out runs reactors IN-TX on a terminal state
(no engine→HR cycle). (2) **HR leave** (`leave_type`/`leave_balance`/`leave_request`):
any staff self-applies at `/leave`; the request rides the staged workflow, and the
finalized-hook (idempotent, PENDING-only) flips APPROVED + decrements the year's
balance, or REJECTED. (3) **Salary change approval + history** (`salary_change_request`):
maker-checker — request (`hr.salary.request`, step-up) then approve by a DIFFERENT
person (`hr.salary.approve`, step-up) applies the new salary to `employee.salaryEnc`;
each row IS the append-only history; old/new salaries encrypted at rest; `upsertEmployee`
no longer changes salary (create-only). (4) **Payroll** (`payroll_run`/`payslip`,
`hr.payroll.run`): a run snapshots active employees' decrypted salary into
field-encrypted payslips + aggregate totals; DRAFT→finalize. (5) **super_admin
self-serve onboarding** (`POST /operator/tenants` + `/operator/tenants/:id/admins`,
`platform.operate` + step-up, audited): creates a school + subscription + first
admin, or adds admins to an existing school. Because the least-privilege app role
has SELECT-only on the GLOBAL `school`/`role` tables, provisioning uses a PRIVILEGED
client (`DATABASE_MIGRATE_URL`→`DATABASE_RETENTION_URL`, like retention/dunning) —
503-disabled when unset. Verified: staged-chain + leave-hook + salary maker-checker +
payroll unit suites, the 6 new RLS cross-tenant cases (coverage gate green), web
typecheck + production build.
HR roadmap progress (of a 15-item list): **#1 structured special requests** — a
`STAFF_REQUEST` carries `{category,details}` (`SPECIAL_REQUEST_CATEGORIES` in
`@sms/types`); per-type initiation rules (`WORKFLOW_TYPE_META` + pure
`canInitiateWorkflowType`) enforced in the workflow controller (PO needs
`fee.manage`, disciplinary `rbac.manage`, content-publish is system-only) and used
to filter the web create dropdown; **#2 payslip PDF** (`GET /hr/payroll/runs/:id/
payslips/:userId/pdf`, pdfkit, audited); **#4 leave coverage** ("who's out",
`GET /hr/leave/calendar`); **#5 statutory payroll** — pure `computeMonthlyPayslip`
(Nigerian PAYE bands + 8% pension) replaces the zero-deduction baseline, and
payroll **finalize is maker-checker** (creator ≠ finalizer). Batch 2 added:
**#3 fractional leave** — half-day support (`leave_request.days` + `leave_balance`
entitled/used are now `DOUBLE PRECISION`; 0.5-day steps; web half-day toggle;
attachment deferred to the doc-vault batch); **#6 payroll bank export** (`GET
/hr/payroll/runs/:id/bank-export` → CSV of name/bank/account/net, audited);
**#9 staff self-service profile** — six field-ENCRYPTED personal/bank columns on
`employee` (`phoneEnc`/`addressEnc`/`nextOfKinEnc`/`nextOfKinPhoneEnc`/`bankNameEnc`/
`bankAccountEnc`); `GET/PUT /hr/me` (gated `workflow.create` = any staff; edits ONLY
personal fields, HR still owns employment + salary); web `MyProfile` on `/leave`.
Migration `20260627160233_*` (no new tables → no RLS file). Batch 3 added the
staff-lifecycle cluster (`apps/api/src/hr/staff-lifecycle.*`, schema 4 tables,
migration `20260627*_hr_staff_lifecycle`, RLS `26_hr_lifecycle_rls.sql`, web
`/hr/staff/[userId]`): **#7 onboarding/offboarding checklists** (`staff_checklist`
+ `staff_checklist_item`, seeded with default tasks per type; toggling the last
task flips the checklist to COMPLETED); **#8 document expiry reminders**
(`staff_document` with `expiresAt`; `POST /hr/staff/documents/reminders/run`
notifies HR of docs due within 30 days, idempotent via `reminderSentAt` — the
cross-tenant DAILY BullMQ sweep mirroring dunning is the only follow-up); **#11
training records** (`training_record`). All gated hr.read/hr.write, audited, with
4 RLS cross-tenant cases (coverage gate green) + a `staff-lifecycle.service` unit
suite. Batch 4 added the reviews cluster (`apps/api/src/hr/reviews.*`, schema 3
tables, migration `20260627*_hr_appraisals_disciplinary`, RLS
`27_hr_appraisals_disciplinary_rls.sql`, web on `/hr/staff/[userId]` + `/leave`):
**#10 performance appraisals** (`appraisal`: DRAFT → SUBMITTED by the reviewer →
ACKNOWLEDGED by the appraisee themselves; rating 1–5; `hr.appraisal.manage`, self-
acknowledge gated `workflow.create` + 404-not-403 scoped to the appraisee); **#12
disciplinary case files** (`disciplinary_case` + APPEND-ONLY `disciplinary_entry`;
open/entry/status; `hr.disciplinary.manage`). 3 RLS cross-tenant cases + a
`reviews.service` unit suite; new perms seeded to principal/school_admin/hr_manager.
Batch 5 (final) COMPLETED the 15-item HR roadmap: **#13 HR analytics**
(`HrAnalyticsService` + `GET /hr/analytics` + `/hr/analytics` — headcount, leave
utilisation, latest payroll cost, expiring docs, training/disciplinary/appraisal
counts; no salary/PII); **#14 recruitment / ATS-lite** (`job_requisition` +
`applicant`, RLS `28_hr_recruitment_rls.sql`; requisitions → applicant pipeline →
`convert` provisions a User+Employee in-tenant via the app role, step-up-gated;
`hr.recruit.manage`; web `/hr/recruitment`); **#15 staff NDPR** (`GET /hr/me/export`
self-service data bundle + `POST /hr/me/erase-personal` clearing the encrypted
self-service fields while RETAINING the statutory employment/payroll record;
buttons on `/leave`). Plus the two follow-ups: **#3 leave attachment**
(`leave_request.attachmentDocId` Document-Vault link, accepted by the API) and
**#8 daily reminder sweep** (`StaffReminderService` + `HrReminderDatabaseService`
privileged client + BullMQ scheduler/processor, mirroring billing dunning — cron
`HR_REMINDER_CRON`, disabled when no privileged URL). The full 15-item HR program
(#1–#15) is now BUILT + verified. 2 new RLS cross-tenant cases (coverage gate green)
+ a `recruitment.service` unit suite.
Post-build consistency/security hardening: (a) `hr.salary.approve` granted to
principal + school_admin (not just hr_manager) so salary maker-checker actually has
a distinct second approver in single-HR schools; (b) `RecruitmentService.convert`
catches the GLOBAL `user.email` unique violation (P2002) → clean 409 instead of a
500 on a cross-school email collision (the RLS-scoped pre-check only sees same-school);
(c) a dedicated `hr.self` permission (seeded to all 8 staff roles) now gates HR
self-service (`/hr/me*`, leave self endpoints, appraisal acknowledge, `/leave` page
+ nav) instead of overloading `workflow.create`; (d) appraisal + disciplinary LIST
reads are now audit-logged (`hr.appraisal.read` / `hr.disciplinary.read`).
Auth is JWT-only — the dev `x-dev-principal` guard bypass has been removed; the
API verifies HS256 with `algorithms: ["HS256"]` pinned.
**Cloud infra is BUILT** as Terraform in `infrastructure/terraform/` (VPC + 3
subnet tiers, ECS Fargate web/api, ALB, CloudFront + WAFv2, RDS Postgres 16,
ElastiCache Redis, S3 Document Vault + customer-managed KMS, Secrets Manager,
ECR, GitHub OIDC deploy role, EventBridge-scheduled retention task). It is
write-only/`validate`-clean here — `plan`/`apply` need real AWS creds (the
sandbox has none). Deploy via `.github/workflows/deploy.yml` (OIDC → build/push
ECR → run the one-off `migrate` task → roll services). The real S3 presigner is
bound when `STORAGE_PROVIDER=s3` (`apps/api/src/documents/s3-storage.provider.ts`);
the local stub stays otherwise.
**End-to-end type-safety spine is BUILT** (single source of truth in
`@sms/types`): see Coding conventions.
**Observability spine is BUILT** (`apps/api/src/observability`, industry-standard
libs — `nestjs-pino`/`pino`, `prom-client`, `@sentry/node`):
(1) **structured JSON logging** — `nestjs-pino` (`LoggerModule.forRoot` in
`ObservabilityModule`; `app.useLogger(pino)` in `main.ts` routes ALL Nest logs
through it) auto-logs one line per request with a `request_id` (from `x-request-id`
or minted; echoed back as a response header), the `school_id`/`user_id` from the
verified JWT (`customProps`), method/route/status/latency. Auth/cookie/step-up/
webhook-sig headers are REDACTED and the query string is stripped (no `?token=`
ever logged); `/metrics` + `/health` scrapes are ignored. `LOG_LEVEL` tunes it.
(2) **Prometheus `/metrics`** — `MetricsService` (a `prom-client` Registry:
default Node.js process/GC/event-loop metrics + `http_requests_total{method,route,
status}`, an `http_request_duration_seconds` histogram, a bounded per-tenant
`tenant_requests_total{school_id}`) fed by `MetricsMiddleware` (applied in
`AppModule.configure`) and exposed by a `@Public` `MetricsController` gated by
`METRICS_TOKEN` (bearer/`x-metrics-token`; open when unset for dev — SET it in
cloud). Route LABEL is the matched pattern, never the raw path, so scanners can't
explode cardinality. (3) **error tracking** — a global `ErrorLoggingInterceptor`
captures 5xx to **Sentry** (`Sentry.init` in `main.ts`, active only when
`SENTRY_DSN` is set — `SENTRY_TRACES_SAMPLE_RATE`/`APP_RELEASE` tune it) with
request/tenant context + logs them, then RE-THROWS unchanged so response semantics
(404-not-403, all status codes) are preserved. Guard rejections (401/403) are
captured by the pino request log. Verified by `metrics.service`/`metrics.controller`
unit tests + an `observability.module` DI smoke test.

## Repo workflow & gotchas
- DB setup order: `prisma migrate deploy` → `pnpm --filter @sms/db rls` →
  `prisma db seed` (or `pnpm --filter @sms/db setup`). RLS lives in `prisma/rls/`,
  NOT prisma migrations — Prisma's shadow DB rejects the `major_user` GRANT.
- New tenant table: add an `prisma/rls/NN_*.sql` file and a cross-tenant case to
  `apps/api/test/rls.e2e-spec.ts` (and its afterAll cleanup, child rows BEFORE
  parents — FK order matters). Register the new rls file in
  `apps/api/docker-entrypoint.sh` (`apply_rls <file> <last-policy-name>`) — the
  entrypoint applies RLS per-file idempotently, keyed on each file's LAST policy
  as a sentinel, so a new file applies onto an already-initialised DB without
  re-running the others. NOTE: you NO LONGER hand-edit `TenantTx` — it is
  `Prisma.TransactionClient` (see below), so new models are typed automatically.
- Integrity retention: telemetry on minors (integrity_signal / submission_draft /
  submission_telemetry) is purged past each school's `School.integrityRetentionDays`
  window by a privileged BullMQ daily sweep + a per-school manual endpoint
  (`POST /integrity/retention/run`, perm `integrity.retention.run`). The app role
  has NO DELETE on those tables; the purge connects via `DATABASE_RETENTION_URL`
  (falls back to `DATABASE_MIGRATE_URL`); unset → retention DISABLED. See
  `apps/api/src/integrity/retention` and `prisma/rls/06_*`.
- Tests: the RLS e2e needs `TEST_DATABASE_URL` (app role) + `TEST_ADMIN_URL`
  (superuser, to seed across FKs); both are declared in `turbo.json`
  `test.passThroughEnv` — Turbo 2 strict env will otherwise SKIP the suite.
- Raw SQL in tests must supply `updatedAt` (Prisma `@updatedAt` has no DB
  default) and quote `"user"` (reserved word).
- Time columns like `Game.turnStartedAt` are `timestamp without time zone`. The
  app round-trips them via Prisma (consistently UTC), but a test that BACK-DATES
  one with raw SQL `now() - interval '…'` stores the DB session's LOCAL wall-clock
  while Prisma reads it back as UTC — a skew on a non-UTC DB. So run the e2e DB on
  UTC (RDS/CI default) OR write the value as `now() AT TIME ZONE 'UTC'`. The full
  api suite (298 tests) is green against a real local Postgres set to UTC.
- RLS coverage gate: `rls.e2e-spec.ts` ends with a meta-test that introspects
  `pg_class`/`information_schema` for every table that has a `schoolId` column AND
  `relrowsecurity=true`, and FAILS if any is missing a cross-tenant deny case (or
  an append-only INSERT/UPDATE test). So a NEW tenant table can't silently skip the
  most-important test category — add it to the `cases` array (seed a row + an
  afterAll cleanup entry) or the meta-test goes red. The only documented exempt is
  the RLS-disabled `ultimate_participant` arena table (cross-tenant by design, no PII).
- Demo logins (password `password123`): `teacher@` / `student@` / `parent@` /
  `admin@` / `principal@` / `board@` / `accountant@` / `hr@` (hr_clerk) /
  `hrmanager@` / `headteacher@` / `headadmin@` / `warden@` / `driver@` /
  `headwarden@` / `headdriver@` / `librarian@demo.school` (+ platform owner
  `owner@sms.platform`).
- Local stack: `cd infrastructure && cp .env.example .env && docker compose up
  --build` → app at http://localhost (nginx). Postgres/Redis are NOT host-exposed.

## Coding conventions
- TypeScript strict mode on. No `any` without a `// reason:` comment.
- All API inputs validated (Zod or class-validator) at the boundary.
- Every mutation writes an audit-log entry (actor, action, entity, school_id, ts).
- Errors never leak cross-tenant existence — return 404, not 403, for
  cross-tenant access attempts.
- Tests: every RLS policy and every permission guard gets a test proving
  cross-tenant access is denied. This is the most important test category.

### Type-safety spine — `@sms/types` is the single source of truth
- Tenant DB handle: `TenantTx = Prisma.TransactionClient` (in
  `integrity.foundation.ts`) — every `tx.<model>` call is fully typed against the
  generated schema, so a wrong/renamed column fails the build. Do NOT reintroduce
  `any` casts (`as Array<Record<...>>`) on tx results.
- JSON columns: cast writes with `as Prisma.InputJsonValue` and narrow reads with
  `as unknown as <Shape>`. `Prisma.InputJsonValue`/`JsonValue` only resolve under a
  VALUE import (`import { Prisma } from "@sms/db"`), not `import type`.
- Response shapes: define server-form DTOs (Date fields are `Date`) in
  `packages/types/src/dto/`. Backend READ controllers annotate return types with
  them (`: Promise<XDto>`) so a service that drops/mistypes a field fails to
  compile. The web consumes `Serialized<XDto>` (the `Serialized<T>` mapped type
  turns Date→string for the JSON wire). One rename breaks producer AND consumer.
- Permissions: backend uses the `<DOMAIN>_PERMISSIONS` constant objects; the web
  uses `hasPermission(perms, perm: Permission)` from `@/lib/permissions` (the
  `Permission` union is every domain's values) — typo'd permission strings fail
  the build. Adding a permission = a new constant + seed change, never a literal.

## MODULE: Assessment Integrity — BUILT (`apps/api/src/integrity`, `apps/web`)
Purpose: deter and DETECT copy/paste and contract cheating on assignments and
tests, and surface signals to teachers for human review. It does NOT prevent or
punish.

### Design principles
- Layered deterrence + server-side detection. Client-side measures are friction
  and signal-collection only; they are NEVER enforcement and are trivially
  bypassable — code must treat them that way.
- All detection produces an `IntegritySignal`, reviewed by a human. See Golden
  Rule #8.
- Telemetry on minors is sensitive PII: consent-gated, audit-logged, retention-
  bounded, and disclosed to schools/parents. Monitoring must be transparent,
  never covert.
- Accessibility: paste-blocking and similar friction MUST have an exemption flag
  per student (assistive-tech / disability accommodation). The feature must
  degrade gracefully or it becomes discriminatory.

### Client-side (friction + signal capture, in apps/web assessment UI)
- Optionally disable paste into answer fields; capture attempted paste events
  (length, timestamp) and POST them as signals rather than silently blocking.
- Detect tab/window blur via `visibilitychange` / `blur` — log as a focus-loss
  signal with duration.
- Capture coarse keystroke timing (cadence, burst detection) — NOT full
  keylogging of content. Store derived metrics, not raw keystroke streams.
- All of the above are toggleable per-assignment and per-student (exemptions).

### Server-side detection (the real value, async via BullMQ workers)
- Paste-origin analysis: large single-event inserts flagged with size + context.
- Typing-behavior analysis: text appearing in one burst, or implausibly fast
  input, flagged. Natural writing has edits/pauses; absence is a signal.
- Similarity detection: compare a submission against (a) others in the same
  class/cohort and (b) prior submissions — embedding cosine similarity for prose,
  n-gram/shingling (MOSS-style) for code. High similarity flagged.
- Draft/version history: autosave drafts; a believable edit evolution lowers
  suspicion, a fully-formed single-version submission raises it.
- Each detector emits a typed signal with a confidence/severity and the evidence
  needed for a teacher to judge — never a boolean "cheated".

### Surfacing
- Signals aggregate into a per-submission Integrity Report on the TEACHER
  dashboard: flags + evidence + context. Teacher reviews and decides.
- `integrity.report.read` permission gates access (teacher, school_admin).
  Students/parents do not see raw signals; disclosure of monitoring is policy-
  level, handled at enrollment/consent.

### Data model (Prisma sketch — all tenant-scoped, school_id non-null)
- `Assessment` — assignment/test; flags: pasteBlocked, focusTracked,
  integrityEnabled.
- `Submission` — studentId, assessmentId, status, submittedAt; relations to
  drafts and signals.
- `SubmissionDraft` — append-only autosave snapshots (submissionId, content
  hash/diff, ts) — supports version-history analysis.
- `IntegritySignal` — submissionId, type (PASTE | FOCUS_LOSS | TYPING_ANOMALY |
  SIMILARITY | DRAFT_ANOMALY), severity, evidence (jsonb), source (CLIENT |
  SERVER), createdAt. APPEND-ONLY. Mirrors the audit-log pattern.
- `StudentIntegrityExemption` — studentId, assessmentId (nullable = global),
  reason, grantedBy — accessibility/accommodation bypass.
- All integrity reads/writes are audit-logged per Golden Rule #5.

### Detection flow
1. Student works in assessment UI → client signals POST to api as they occur.
2. On submit (and on autosave), api enqueues a BullMQ integrity job.
3. Worker runs server-side detectors, writes `IntegritySignal` rows.
4. Teacher dashboard reads aggregated signals via `integrity.report.read`.
5. Human reviews; any consequence is a manual teacher action, separately logged.

## MODULE: Dead & Wounded Gaming Platform — BUILT (spec: `DEAD_AND_WOUNDED_PLATFORM_SPEC.md`)
A competitive number-guessing game (Bulls & Cows / Mastermind family) with five
game modes built on one shared, pure scoring engine. The FULL spec lives in
`DEAD_AND_WOUNDED_PLATFORM_SPEC.md` at the repo root — READ IT before any work on
the game. The entire spec §11 build sequence (steps 1–8) is now implemented;
typecheck (13/13 turbo tasks) and the 118 game-engine unit tests pass. The DB-backed
e2e/RLS suites need a provisioned Postgres (TEST_DATABASE_URL app role +
TEST_ADMIN_URL superuser) and run in CI / locally-with-creds, not the sandbox.

BUILT (spec §11 steps 1–8):
- **Step 1 — pure scoring engine** (`packages/game-engine/scoring.ts`): `score`/
  `isWin`/`validate`/`generateSecret`, variable length N=4/5/6, exhaustively tested.
- **Step 2 — standalone 2-player online game** (`apps/game-server`): native-ws,
  server-authoritative match (`match.ts`) behind a swappable store seam.
- **Step 3 — SMS integration of the duel** (`apps/api/src/game`, schema
  `game.prisma`, RLS `18_game_rls.sql`): tenant-scoped Game/GamePlayer/Guess/
  GameResult, relationship-scoped (participant-only, 404-not-403), audited,
  secrets server-only + cleared on finish. `game.play`/`game.leaderboard.read`.
- **Step 4 — Category 3 League/Knockout** (`competition.service.ts` +
  `competition.controller.ts`, schema Competition/Standing, RLS
  `19_competition_rls.sql`): pure round-robin/knockout-bracket/standings logic in
  `game-engine/competition.ts` (byes never twice, 3/0 points, guess-count then
  head-to-head tiebreak — all unit-tested); matches are normal duels played
  through GameService; `GameService.finish` hooks `CompetitionService.afterMatchFinished`
  (one-way dep, no cycle) to update standings / advance the bracket; an overdue
  `sweep` forfeits no-shows (48h window). `game.league.create` (principal/
  school_admin) + leaderboard read.
- **Step 5 — Category 2 Class Race** (`race.service.ts` + `race.controller.ts`,
  schema: `Game.classId` + server-only `Game.targetSecret`, migration
  `20260625000000_race` — NO new RLS file, reuses the `game`/`competition`/
  `standing` policies): teacher opens a race for THEIR class around one shared
  server-only target; enrolled students join and race in PARALLEL (no turns,
  routed through RaceService NOT GameService); first 3 to crack win (top-3 by
  finish order). Per-student guess redaction (a racer sees only their own
  guesses; target never serialized, cleared on finish), per-racer guess
  rate-limit, own-start `elapsedMs`. Cross-class **tournament** = one RACE per
  class (each its own target) under a `Competition(RACE_TOURNAMENT)`, with
  per-class + combined standings via the pure `computeRaceStandings` (fewest
  guesses → fastest own-start elapsed). `game.race.open` (teacher own-class /
  principal / school_admin) + `game.race.tournament` (principal / school_admin).
- **Step 6 — Category 1 Elimination Ring** (`ring.service.ts` + `ring.controller.ts`,
  schema: `Game.turnStartedAt` + `GamePlayer.eliminatedById`, migration
  `20260626000000_ring` — NO new RLS file, reuses the `game` policies): N players
  in a ring, each targeting the next; a crack ELIMINATES the target, the ring
  RE-CLOSES (cracker inherits the eliminated player's target), and the cracker
  gains the eliminated player's session guess history (the §4 reward, scoped via
  `eliminatedById` — nobody else sees it). One guess per turn, turn order enforced
  server-side; the 60s limit is validated from `turnStartedAt` with the graduated
  rule (skip ×2 → forfeit on 3rd consecutive timeout). Last standing wins;
  placings recorded (reverse elimination order); secrets cleared on finish. A RING
  is turn-based and owns its lifecycle (does NOT route through GameService). The
  in-memory real-time transport (step 2) still owns the 15s countdown /
  hard-disconnect; live *spectating* of a durable ring is now served by the
  `/ws/watch` push bridge (see "Live push" below). `game.play` to play;
  `game.match.moderate` (teacher/principal/school_admin) to force-end.
- **Step 7 — Category 5 Administration / RBAC** (`game-settings.service.ts` +
  `game-settings.controller.ts` + `game-settings.util.ts`, schema GameSettings,
  migration `20260627000000_game_settings`, RLS `20_game_settings_rls.sql`):
  finalizes the per-mode RBAC and makes `game.settings.manage` (school_admin)
  REAL via per-school config — one tenant-scoped GameSettings row (gamesEnabled,
  defaultDifficulty, guessRateLimitMs, ringTurnLimitSec, leagueMatchWindowHours,
  crossSchoolEnabled). `effectiveGameSettings` merges the row over platform
  defaults; the four game services CONSULT it via a tx helper (no constructor
  churn): `gamesEnabled` gates open/create; `defaultDifficulty` fills an omitted
  difficulty (difficulty is now optional on open/create); race guess rate-limit,
  ring turn limit, and league match window all come from settings. GET is broad
  (`game.leaderboard.read`); PUT is `game.settings.manage` (school_admin only —
  principal does NOT get it, per §8 config-vs-operations split). `crossSchoolEnabled`
  is consulted by step 8.
- **Step 8 — Category 4 Ultimate (cross-school)** (`ultimate.service.ts` +
  `ultimate.controller.ts`, schema `ultimate.prisma`, migration
  `20260628000000_ultimate`, RLS `21_ultimate_rls.sql`): the ONE deliberate
  tenant-boundary crossing, built as a SEPARATE surface with TWO opposite-posture
  halves. (A) CROSS-TENANT, RLS-EXEMPT arena (`UltimateCompetition` /
  `UltimateParticipant`) — explicitly listed in the RLS file like `school`/`role`;
  safe because it carries NO PII (opaque participant id, handle, schoolId for
  grouping, server-only per-entry secret never serialized, scores). (B)
  TENANT-SCOPED governance/bridge (`UltimateEnrollment` tier-1 school opt-in,
  `UltimateConsent` tier-2 per-student guardian consent, `UltimateEntryLink` the
  ONLY userId↔participantId map) under standard RLS — so an arena row
  de-anonymises only WITHIN its owning school. Entry requires BOTH consent tiers
  PLUS the school's `crossSchoolEnabled` posture (step 7). What crosses the wire:
  handle + school NAME + scores, nothing else. Each player guesses their OWN
  per-entry target; the cross-school leaderboard ranks finishers via the pure
  `computeRaceStandings` (fewest guesses → fastest own-start elapsed). Admin
  (create/cancel) `game.ultimate.admin` (super_admin only); `game.ultimate.enroll`
  (principal/school_admin); `game.ultimate.consent` (school_admin); enter/guess/me
  `game.play`; list/leaderboard `game.leaderboard.read`. All mutations (incl. every
  consent change + arena entry) audit-logged. RLS-e2e covers the tenant-scoped
  bridge tables (arena tables excluded by design — cross-tenant, no PII).

The full §11 build sequence is COMPLETE. `game.ultimate.*` perms are now seeded.

**Game web UI is BUILT** (`apps/web/app/(app)/games/*` + `apps/web/components/game/*`):
a permission-gated Games section reachable from the AppShell nav (gated on
`game.leaderboard.read` so students/teachers/principal/school_admin all see it).
A hub (`/games`) offers Quick Duel + Elimination Ring start buttons, an open-duels
join list, a teacher Class-Race opener, a Leagues/Knockouts list + create form
(`game.league.create`), an Ultimate entry point, and the school GameSettings form
(`game.settings.manage`). Per-mode play screens are LIVE over the `/ws/watch` push
bridge with a REST poll fallback (see "Live push" below): `/games/duel/[id]`
(`DuelPlay`), `/games/ring/[id]` (`RingPlay`, incl. inherited-history reveal +
turn countdown), `/games/race/[id]` (`RacePlay`), `/games/league/[id]`
(`LeagueView` — live standings + matches linking to the duel screen), and
`/games/ultimate` + `/games/ultimate/[id]` (`UltimatePlay` handle entry +
live cross-school leaderboard, plus staff enroll/consent and super_admin create via
`UltimateAdmin`). Shared client primitives (`play-ui.tsx`):
`GuessForm`/`GuessList`/`ScorePips`/`useLiveGame` (WS-primary + poll fallback;
`usePolled` remains for non-live lists)/`LiveDot`/`postSms` + a client-side
N-distinct-digit pre-check (server re-validates). All screens consume
`Serialized<…>` DTOs and gate affordances with `hasPermission`.
The hub also lists joinable Class Races via `GET /races` (`RaceService.listRaces`
→ `RaceSummaryDto[]`): relationship-scoped exactly like the per-race view
(school-wide staff see all open races; teachers see races for classes they teach;
students see races for classes they're enrolled in, plus any they've joined),
LOBBY/ACTIVE only, no target ever serialized; covered by a relationship-scoping
case in `race.service.e2e-spec.ts`. Verified by `tsc --noEmit` (web typecheck clean; the only
diagnostic is the Next TS-plugin 71007 "serializable props" warning on shared
client-to-client components — editor-only, not a tsc/CI failure).

**Live push — BUILT** (`apps/api/src/game-socket`, `GameEventsService`, web
`useLiveGame`). The durable REST core stays the SOLE authority; live updates are a
thin read-only spectator bridge layered on top:
- `GameEventsService` (`apps/api/src/game/game-events.service.ts`) — an in-process
  pub/sub. Each durable mutation, AFTER its tx commits, emits the changed id
  (gameId; for league matches ALSO the `competitionId`; for Ultimate the GLOBAL
  arena competition id). Carries NO data and NO authority — just an id nudge — so
  it can't become a second source of truth or leak across tenants. **Cross-instance
  via Redis** (`RedisPubSubService`, `apps/api/src/common`): the producer delivers
  to its OWN local subscribers directly and fans the nudge to other ECS tasks over
  Redis pub/sub (echo-skipped by per-instance id → exactly-once); degrades to the
  original process-local EventEmitter when Redis is absent (`REDIS_PUBSUB_DISABLED`
  or unreachable). The SAME `RedisPubSubService` also fans `ModuleEntitlementService`
  cache invalidation across tasks — so a billing/operator subscription write on one
  replica drops the stale entitlement on ALL replicas (channel `entitlement:invalidate`),
  not just the one that handled the request.
- `GameSocketGateway` hosts `ws` on the SAME http server via the `noServer`
  upgrade pattern, claiming only `/ws/*`. `/ws/duel|ring|race|arena` are the
  in-memory step-2 transport; `/ws/watch?mode=…&gameId=…` is the durable bridge:
  on each matching nudge it re-reads the RLS-scoped, viewer-redacted view via the
  matching durable service and pushes it — exactly what the mode's HTTP GET
  returns. Modes + their getter/permission (mirrors each GET): `duel`→`getGame`/
  `game.play`, `ring`→`getRing`/`game.play`, `race`→`getRace`/`leaderboard.read`,
  `league`→`competition.get`/`leaderboard.read`, `ultimate`→`ultimate.leaderboard`/
  `leaderboard.read` (pseudonymous board only — no PII crosses). 404-not-403 +
  token-derived identity preserved. Handshake auth: HS256 `?token=` (the web BFF
  `GET /api/ws-ticket` mints a short-lived token from the session — the same
  established `?token=` mechanism the step-2 sockets use). Unit-tested in
  `game-socket.gateway.spec.ts` (per-mode permission gates, mode routing,
  404-not-403, filtered re-read, teardown) + `game-events.service.spec.ts`.
- Web `useLiveGame` (`play-ui.tsx`): fetches a ws-ticket, opens the watch socket,
  pushes `{type:"state"}` frames into the view; pauses polling while connected and
  resumes + reconnects (backoff) on any failure, so a screen NEVER goes stale even
  where sockets are unavailable. `LiveDot` shows Live vs Polling.
- Routing: local `infrastructure/nginx` proxies `/ws/` → backend; cloud Terraform
  forwards ONLY `/ws/*` to a dedicated API ALB target group (secret-header-gated
  listener rule; REST still flows web→api via Cloud Map). Dev sets
  `NEXT_PUBLIC_WS_URL=ws://localhost:3001`; behind nginx/CloudFront it's same-origin.

Still in the in-memory step-2 transport only (NOT the durable bridge): the live
turn timers / 15s countdown / hard-disconnect handling for actively-played
sockets.

**FULL-STACK VERIFIED end-to-end (2026-06-27) against a real Postgres 18 (UTC):**
migrate deploy (all migrations incl. all 6 game ones) → all 24 RLS files apply
clean (`ON_ERROR_STOP=1`) → seed OK (game RBAC confirmed in DB: 10 `game.*` perms;
ultimate.admin→super_admin, ultimate.consent→school_admin, ultimate.enroll→
principal+school_admin). The ENTIRE api jest suite passes: **40 suites / 298 tests**
(every module + RLS cross-tenant incl. ultimate + all 5 game modes + the new
`GET /races`; the RLS suite now proves isolation for EVERY one of the 71 RLS-enabled
tenant tables + a coverage meta-test that fails if a new one is added untested).
game-engine **118/118**, monorepo typecheck **13/13**, and the web
**production build** compiles all routes incl. the 7 game screens. Two pre-existing
game e2e assertions were FIXED (a winner's cracking guess necessarily equals the
secret and legitimately shows in the public move log / own history — the naive
`not.toContain(secret)` over the whole view was wrong; now asserts the UN-cracked
secret never leaks + the stored secret/target column is cleared). NOTE: these DB
suites `describe.skip` without `TEST_DATABASE_URL`+`TEST_ADMIN_URL`, so they had
never actually executed before this run.

Binding points even from here:
- Build order: pure scoring engine first (variable length — 4/5/6 distinct
  digits; `length` is a PARAMETER, never hard-coded; test N=4/5/6), then a
  standalone 2-player online game (WebSockets, server-authoritative), then SMS
  integration, then the five modes. The cross-school "Ultimate" mode is built
  LAST (spec §10 build sequence).
- Server authority is absolute: secrets stored server-side only and NEVER sent to
  an opponent's client; scoring, turn order, finish order, and win detection are
  computed server-side; clients are display-only. Validate every secret/guess
  server-side (N distinct digits 0–9).
- Tenant model: all per-school game tables are tenant-scoped (non-null `school_id`
  + RLS) and follow the standard built-module pattern (relationship scoping,
  404-not-403, audited mutations, an RLS-e2e cross-tenant case). The ONE exception
  is the cross-school "Ultimate" arena — a deliberately separate, super_admin-
  gated cross-tenant surface (spec §7) that must NEVER leak student PII or other
  tenant data across the boundary; document exactly which fields cross it.
- New-table mechanics follow "Repo workflow & gotchas": add `prisma/rls/NN_*.sql`,
  register it in `docker-entrypoint.sh` (`apply_rls`), add the RLS-e2e case +
  FK-ordered afterAll cleanup. `TenantTx` is `Prisma.TransactionClient`, so new
  models are typed automatically — do NOT hand-edit it or add `any` casts.
- Type-safety spine applies: server DTOs in `packages/types/src/dto/`, web consumes
  `Serialized<XDto>`; `game.*` permissions are `<DOMAIN>_PERMISSIONS` constants in
  `packages/types/src/permissions`, added + seeded in `seed.ts` ONLY when the
  module is built (spec §8 has the finalized set and the Principal=operations /
  School-Admin=configuration split). Don't add unused permissions now.
- Minors' privacy (Golden Rule #5): display names within a school; handles —
  never real names — across schools; cross-school play requires two-tier consent
  (school enrollment + a per-student guardian consent flag), audit-logged.

## July 2026 review-and-hardening sweep — BUILT
Three full application reviews (security / consistency / efficiency / revenue)
plus user-driven fixes, all verified against the live stack:
- **Concurrency guards**: workflow transitions write via optimistic `updateMany`
  on `(id, state, currentStage)` (no lost approvals / double stage-advance);
  hostel allocation row-locks the room (`SELECT … FOR UPDATE`) before the
  capacity count; library issue atomically CLAIMS a copy (`updateMany
  availableCopies >= 1` + decrement). Proven with live concurrent requests.
- **Role-based "student" everywhere**: `listStudents` (staff path) and the
  operator's cross-tenant student view list users holding the student ROLE
  (ROSTER_WIDE_ROLES governs the school-wide list; enrollment-derived lists hid
  every not-yet-enrolled student). Relationship-scoped paths unchanged. One
  definition of "student" = the billing seat count.
- **FEE_SCHEDULE maker-checker** (workflow type, systemOnly): hostel/transport
  fee runs move money, so a (head-)warden / head-driver run creates an approval
  request (initiator billing scope snapshotted into the payload); a
  `workflow.review` holder (≠ initiator, engine-enforced) approves and a
  WorkflowHooks reactor posts the run in the SAME tenant tx. Admins post direct.
- **Rename/delete parity** with dependency guards (409 + a message saying what
  blocks it): classes (empty-only), subjects (+ case-insensitive duplicate guard
  on create; offering-removal endpoint), library books (no loan history),
  hostels (no rooms) + rooms (no allocation history), vehicles (no routes) +
  route rename. Ledger history is never deletable.
- **Error interpretation**: `apps/web/lib/api-error.ts` + `sendSms(method, …)`
  in `play-ui.tsx` — every mutation failure carries the server message PLUS a
  plain-language status interpretation; all postSms consumers upgraded at once.
- **Bulk SIS import credentials**: approval generates a UNIQUE random temp
  password per student (hashed OUTSIDE the tx — bcrypt×N would blow the 5s
  interactive-tx cap; guarded batch claim), returns them ONCE (`credentials` on
  the approve response; login-slips CSV in the UI, formula-guarded), and sets
  `passwordChangedAt=null` to force a first-login reset.
- **HR account↔employment bridge**: /hr flags staff accounts awaiting an
  employment record; `hr/analytics` headcount adds `staffAccounts`+`unrecorded`;
  per-row inline Edit on the register (salary excluded — pay stays maker-checker).
- **Operator console at scale**: `GET /operator/tenants` is server-side
  searched/filtered/paginated (`q`/`plan`/`billing`/`page` → `TenantPageDto`);
  the registry query runs on the PRIVILEGED client (the subscription relation is
  tenant-scoped — an app-role relation filter under the operator's GUC silently
  matches nothing). Enrichment costs pageSize, not fleet-size. Light
  `GET /operator/tenant-names` feeds pickers.
- **Frontend "Register" identity**: Spectral display serif via next/font (the
  `--font-*` vars must be bound ONLY by next/font — a `:root` redeclaration
  later in the bundle silently beats next/font's class and disables the
  webfonts) + the `--rule` exercise-book margin-rule token (decorative only).
- **Efficiency**: analytics counts via `groupBy`/`count()`; competition
  standings `createMany` + batched result reads; messaging thread reads capped
  at 500 most-recent.

## MODULE: Scholarship — platform-sponsored, cross-tenant — BUILT
(`apps/api/src/scholarship`, web `/scholarships` + operator console; schema
`scholarship.prisma`, migration `20260730000000_scholarship`, RLS
`50_scholarship_rls.sql`.) A parent/teacher applies for a platform-owner-sponsored
scholarship on behalf of a student in THEIR school. Two-halves posture (mirrors
the Ultimate arena): (A) `ScholarshipProgram` is GLOBAL, platform-owned,
RLS-EXEMPT (listed like `school`/`plan_price`; app role SELECT-only, writes via the
PRIVILEGED client); (B) `ScholarshipApplication` is TENANT-scoped (non-null
school_id + standard RLS, append-only decisions — no hard-delete). ALWAYS-ON (no
`@RequireModule`) — it's a growth lever, open to every plan. Permissions:
`scholarship.apply` (parent/teacher — relationship-scoped, 404-not-403),
`scholarship.read` (leadership oversight), `scholarship.admin` (super_admin only —
NON_ELEVATABLE). Flow: apply (DRAFT) → GUARDIAN CONSENT required (Golden Rule #5;
only a `parentChild` guardian may consent) → submit snapshots verified SIGNALS
(published grade avg / attendance / outstanding fees — signals for the reviewer,
never a verdict, Golden Rule #8) → the platform owner reviews the cross-tenant
queue (privileged client) → REVIEW/SHORTLIST/REJECT (no step-up) or AWARD
(step-up). An AWARD disburses through the FEES ledger: a new
`PaymentKind.SCHOLARSHIP` payment posted against the student's open invoice in
their own school (capped at balance; invoice → PARTIALLY_PAID/PAID) — integer
kobo, audited, `disbursementPaymentId` links back. Program CRUD + review + award
all audited in the operator's own tenant. Verified: 8 scoping unit tests + the
`scholarship_application` RLS cross-tenant case (coverage gate green) + live
end-to-end (create→apply→consent-gate→submit→signals→cross-tenant review→award→
₦-credit on the invoice) + web production build (67 routes) + route smoke.

## When generating code
- Explain the multi-tenancy/security implication of each new table or endpoint.
- After scaffolding, output RLS SQL and migrations SEPARATELY for review before
  applying (RLS goes in `packages/db/prisma/rls/`, not Prisma migrations).
- Every new module follows the built pattern: tenant-scoped tables + non-null
  `school_id` + RLS, a service with relationship scoping (404 not 403), audited
  mutations, an RLS-e2e cross-tenant case, and a unit test for the scoping logic.
- Prefer small, reviewable commits over one giant change.