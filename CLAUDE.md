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
- Global (non-tenant) tables are listed and GATED, not merely described:
  `rls.e2e-spec.ts` fails if any table has row security off and is not on its
  documented list. Exactly seven qualify — `_prisma_migrations`, `school`, `role`,
  `permission`, `role_permission`, and the deliberate cross-tenant Ultimate arena
  pair (`ultimate_competition`, `ultimate_participant`).
  // GOTCHA: "global" is NOT the same as "unprotected", and calling them
  RLS-EXEMPT undersold the posture. `plan_price`, `module_addon_price`,
  `platform_fee_config`, `promo_code`, `agent` and `school_group` have no
  `schoolId` AND have RLS ENABLED with restrictive policies — app-role SELECT-only or deny-all, writes
  through the privileged client. Only the seven above have no row security at
  all, and a new one cannot be added quietly.

## RBAC model (custom, data-driven)
- Roles live in DB tables (`Role`/`Permission`/`RolePermission`/`UserRole`),
  seeded in `packages/db/prisma/seed.ts`: super_admin (cross-tenant), board
  (read-only oversight + workflow veto), principal, school_admin, teacher,
  student, parent, accountant, hr_clerk, hr_manager (owns leave/salary/payroll +
  stage-2 approver), head_teacher / head_admin (stage-1 approvers for the staff-
  request chain), warden (their own hostel), driver (read-only own vehicle),
  head_warden (EVERY hostel), head_driver (whole fleet), librarian (library
  module), junior_admin (day-to-day operational tier under school_admin: records/
  attendance/timetable/documents + fee RECORDING + admissions review, but NO
  approval powers — no rbac.manage / fee.approve / workflow.review; split by risk
  of escalation like platform manager_admin) — and the two PLATFORM roles,
  super_admin (cross-tenant) and manager_admin (the platform-staff floor whose
  real duties are LENT, see below). NINETEEN roles in all: 17 school-scoped plus
  those two. `ROLE_PERMISSIONS` in `@sms/types` is the single source and the seed
  reads it; `claims-in-claude-md.spec.ts` fails if this paragraph and that map
  stop agreeing, because a count typed into prose rots the moment a role is added
  — this one said "18 school roles" and had never heard of manager_admin.
  Adding a role/permission is a seed change, not new code.
- Admin-tier governance guards (AdminService): nobody may remove their OWN
  school_admin/principal role, and the LAST managing role in a school can't be
  removed (only the operator can vacate it). Any grant that TOUCHES the
  junior-admin tier (appointing a junior_admin, or stacking further roles onto
  one) is maker-checker: it raises an ADMIN_APPOINTMENT workflow request
  (systemOnly type) that a DIFFERENT workflow.review holder approves; the grant
  lands in-tx via the finalized hook, audited to the initiator.
- Permissions are fine-grained strings (e.g. `student.read`, `grade.write`,
  `workflow.review`, `integrity.report.read`) in `packages/types/src/permissions`.
- Authorization is checked in NestJS via `@RequirePermission('grade.write')` +
  the global PermissionGuard, AND backstopped by RLS at the DB.
- Relationship scoping beyond role IS IMPLEMENTED (LmsService is the reference):
  teacher→their classes, student→enrolled, parent→their children. Coarse
  permission gates the endpoint; membership joins narrow the rows; RLS backstops.
- **Inside a school, duties move BOTH ways.** Bottom-up (existing): a junior_admin
  REQUESTS a permission, a DIFFERENT senior approves, it auto-expires — 49 of the 54
  permissions school_admin holds and junior_admin lacks are reachable this way.
  Top-down (new): `SecurityService.delegateElevation` lets a senior HAND OVER a duty
  they already hold, unasked, for cover — `POST /security/elevation/delegate`
  (`security.elevation.approve`), `privilege_grant.delegated = true`, ACTIVE at once,
  revocable via the existing revoke, audited. Reuses privilege_grant, so it inherits
  that table's RLS and the guard's `hasActiveGrant`. **The check that makes top-down
  safe: the granter must ALREADY HOLD the permission** — a handover moves authority
  sideways, never manufactures it. `isElevatable` still applies, so the maker-checker
  authorities (`fee.approve`, `hr.salary.approve`, `rbac.manage`,
  `security.elevation.approve`, `billing.manage`) can be lent by nobody, to nobody,
  for any duration: lending the approving half of a two-person rule removes the
  control rather than sharing the work. `HandoverPanel` on /admin/security offers
  only the caller's OWN permissions, and names the unlendable ones rather than
  hiding them.
- **Schools have a REGION, and academic shape is per-school.**
  `school.country/timezone/locale/currency/complianceRegime/calendarTemplate/gradingPolicy`
  (migrations `20261117000000`, `20261118000000`), all nullable — null means the
  platform's home country, so schools already live are unchanged. `@sms/types/region.ts`
  holds a 12-country catalogue; `SchoolRegionService` (foundation, @Global, 60s cache)
  resolves and caches it. // GOTCHA: **"today" is the SCHOOL's calendar day**, not the
  server's UTC day — `schoolToday(tz)`. The register, the gate-scan check-in, the term
  lock, the 7-day stale rule, the EXAM RELEASE gate, the STAFF clock-in, the
  installment OVERDUE state and the receivables aging buckets all use it; deciding in UTC filed a Singapore morning
  register against Sunday and a Toronto evening one against Tuesday. Statutory payroll
  is COUNTRY PACKS (`PAYROLL_PACKS`): **Nigeria and the UK** implemented, everything
  else `payrollPack: null` and `createRun` REFUSES — a payslip wrong about tax goes to an
  employee and a revenue authority. Calendar templates (THREE_TERM / TWO_SEMESTER /
  FOUR_QUARTER / TRIMESTER) and grade weighting (must total 100, else the default is
  used) are per-school. Region is operator-set: `PUT /operator/tenants/:id/region` behind its OWN
  permission `platform.tenants.region` (+ step-up, privileged write, invalidates
  the cache). NOT `tenants.write` — that is day-to-day provisioning a manager may
  hold STANDING, and a region change silently flips the privacy regime, disables
  statutory payroll and moves every register's day boundary. Lendable for a
  bounded window, never standing — the same tier as `tenants.status`.
- **Web display follows the SCHOOL, not the platform.** `lib/format.ts` pinned
  `en-NG`/`Africa/Lagos` for everyone; the region now rides the session
  (`user.locale/timezone/currency`, +85 bytes on the cookie) and `AppShell` publishes
  it via `RegionProvider` — client islands use `useFormat()`, server components
  `regionOf(session.user)`. It MUST come from the session, not the runtime: a
  Node-vs-browser default is a React hydration mismatch, which a user sees as a blank
  page. // GOTCHA: **a `@db.Date` is a DAY, not an instant.** It serialises as
  midnight UTC, so rendering it in a zone west of UTC shows the PREVIOUS day — a
  naive "use the school's timezone" would have dated every Toronto register a day
  early. `isCalendarDate` detects exact-UTC-midnight and renders those in UTC;
  only true timestamps convert. Invoice/payment money already carried its OWN
  currency per row and still does — an NGN invoice prints in naira whatever the
  school's currency is; only NEW invoices default to the school's.
- **MOBILE MONEY — BUILT** (`apps/api/src/payments/mobile-money.*`, `mobile_money_intent`,
  migration `20261120000000`, rls/101, web `MobileMoneyButton`). M-Pesa (Daraja STK
  push), MTN MoMo (Collections) and Airtel Money (Airtel Africa Open API) — all
  three implemented. `MOBILE_MONEY_COVERAGE` in `@sms/types` is a DATA table — a new
  country is a row, never a branch — and the school's REGION picks the rails.
  // GOTCHA #0, and the reason `*-wire.spec.ts` exists: **NO PROVIDER SANDBOX HAS
  EVER BEEN EXERCISED** (no credentials, no public callback URL). The rails are
  instead pinned against each provider's PUBLISHED contract, using their real
  documented callback bodies. Doing that found six money-losing defects that every
  unit test had passed over, because a fixture shaped like our own code only proves
  the code is self-consistent. **The three rails disagree about almost everything,
  and each disagreement was a bug:** Daraja never echoes `AccountReference` (match
  on `CheckoutRequestID`), MTN does echo it (`externalId`) and calls back by **PUT**,
  Airtel wants a **NATIONAL** msisdn while the other two want international, MTN
  authenticates with Basic and Airtel with a JSON POST, MTN's success is **202 with
  an empty body** and Airtel's is a **200 carrying `success:false`** on failure.
  Assume nothing carries across rails. Before switching a school on, run that
  provider's sandbox — the wire tests are necessary, not sufficient.
  // GOTCHA, and the reason the intent table exists: **M-Pesa and MTN callbacks are
  UNSIGNED**, unlike Paystack/Stripe. A callback is a doorbell, never a source of
  amounts: we write `MobileMoneyIntent` (school, invoice, amount) BEFORE the prompt
  goes out and settle from OUR figure. Settlement goes through the existing
  `InvoiceSettlementService` — no second posting path — so it is idempotent on our
  reference and cannot disagree with the card rail. Callbacks ALWAYS answer 2xx; a
  non-2xx makes a rail retry forever.
  // GOTCHA #2: it lives in its OWN module. `NotificationModule` imports
  `PaymentsModule`, so a rail in PaymentsModule that imports `SettlementModule`
  (which imports NotificationModule) is a CYCLE and Nest will not boot — and 1,402
  unit tests, the typecheck and the web build all stayed green, because none of them
  builds the module graph. `test/payments/module-graph.spec.ts` now pins it.
  // GOTCHA #3: `/api/health` is the WEB tier's probe and answers 200 with the API
  DOWN. Use `/api/public/plan-pricing` to prove the API is actually up.
- **Money is scaled by the CURRENCY, never by 100** (`packages/types/src/currency.ts`).
  The platform stored integer minor units and divided by 100 everywhere — right for
  NGN/GHS/KES/ZAR/USD/GBP, and 100× WRONG for the CFA franc and every other
  zero-decimal currency: 11 of the 29 African countries in the catalogue. Use
  `formatMoney` / `toMajor` / `toMinor`; `minorUnits()` asks Intl rather than a
  hand-kept table. // GOTCHA: `CURRENCIES` (what the platform can EXPRESS for its
  own billing) is NOT the same question as `planCurrencies()` (what it can SELL in
  — needs a price list AND a rail). `PLAN_PRICING_BY_CURRENCY` is PARTIAL, an
  operator `plan_price` row can open a new currency, and `PlanPricingService
  .effective()` refuses a currency with no prices rather than quoting zero. A
  school's FEE currency is a free-form ISO code on `school.currency` and is a
  separate thing again.
  // GOTCHA: the READING half of this was fixed long before the WRITING half.
  Components were given `useFormat()` and comments about "the SCHOOL's currency,
  not the platform's", and still sent `Math.round(Number(x) * 100)` two lines
  below — so a school was shown its francs correctly and stored a hundred times
  what the bursar typed. Fourteen sites: salary, staff loans, fee items, invoice
  lines, adjustments, credits, instalments, late fees, admission fees, transport
  costs. `minorFrom`/`majorFrom` in `lib/format.ts` are the missing direction and
  ride `useFormat()` beside `money`; where a row carries its OWN currency the
  helper follows that. The PUBLIC directory had no session to read a region from
  and hard-coded `en-NG`/NGN for every school, so `PublicSchoolDto` now carries
  `currency`. Gate:
  `apps/web/lib/__tests__/money-is-not-divided-by-a-hundred.test.ts` fails the
  build on a literal 100 near a money word, with a named exemption per genuine
  platform-currency site.
- **A NAIRA CONSTANT IS NOT A RULE FOR EVERY SCHOOL.** Two figures were written
  in kobo and applied whatever `school.currency` says. The maker-checker
  threshold `PAYMENT_APPROVAL_THRESHOLD_MINOR` (5,000,000) is ₦50,000 as
  intended and **£50,000 in a British school** — a two-person rule that never
  fires, degrading in SILENCE while /fees and the manual go on promising it; and
  the library's `FINE_PER_DAY_MINOR` (5,000) is ₦50 a day and **£50 a day** on a
  family's invoice for an overdue reading book. There is no FX rate in this
  platform and inventing one to convert a control would be worse than the bug,
  so the school states the figure: `school.paymentApprovalThresholdMinor` and
  `school.libraryFinePerDayMinor` (both NULLABLE, migration `20261231000000`, on
  the /fees/reports money-policy card, step-up + privileged write).
  // GOTCHA: **the two fail-safes point in OPPOSITE directions and that is the
  whole point.** An unset CONTROL tightens — every payment is reviewed until a
  figure is set — because a control that relaxes when unset stops protecting. An
  unset CHARGE goes to ZERO, because a charge that guesses bills a family.
  Golden Rule #7 read properly is "the more restrictive option", and which
  option is more restrictive depends on who the rule is pointed at; hence two
  named resolvers (`effectivePaymentApprovalThresholdMinor` /
  `effectiveLibraryFinePerDayMinor`) rather than one shared "default for this
  currency" helper. A school on the platform's own currency is UNCHANGED, so
  nothing moves for anyone already live. `paymentNeedsApproval` now takes a
  REQUIRED `thresholdMinor` — a required parameter is a search for every caller
  relying on the default, the same trick that found the Paystack currency sites.
- **A GATEWAY IS ALWAYS TOLD THE CURRENCY** (`PAYSTACK_CURRENCIES` /
  `paystackCanSettle` in `currency.ts`). Omit it and the rail charges in ITS OWN
  account currency: `transaction/initialize` was never sent one, and **27 of the
  29 catalogued currencies routed to Paystack**, so a Ghanaian school's GHS 5,000
  invoice charged the parent **NGN 5,000** — about a tenth — while settlement
  marked the invoice PAID. School underpaid, ledger says otherwise, nothing
  logged. `PaystackService` now REFUSES a currency the rail cannot settle
  (NGN/GHS/ZAR/KES/USD) instead of defaulting, and names it on every call
  including saved-card renewals; the refusal points the payer at mobile money,
  which covers most of the countries it rejects. The check lives in the SERVICE,
  not at seven call sites. // GOTCHA: making `currency` a required field is what
  found them — a required parameter is a search for every caller that was
  relying on a default.
- **EVERY rail is reconciled, and settlement REFUSES a currency mismatch.**
  `InvoiceSettlementService.applyOnlinePayment` takes a required `currency` and
  compares it to the invoice BEFORE posting (before the idempotency check, so a
  mismatch is never masked as a duplicate). It is the ONE posting path, so this one
  guard covers card, mobile money, dedicated-NUBAN, both verify-on-return paths,
  the reconciliation sweep and any rail not yet written. A refusal leaves the
  invoice OPEN and logs at ERROR — recoverable; posting is not, since nothing
  revisits a settled invoice. Both gateway LISTINGS and verifies now report the
  charge currency (they did not, so reconciliation could not have checked even if
  it wanted to). // GOTCHA: **Stripe reports currency lower-case** (`"usd"`); the
  adapters uppercase at the boundary. // GOTCHA: the receipt formatter still did
  `minor / 100` under a hard-coded `en-NG`, printing a CFA-franc receipt at a
  HUNDREDTH of its value — on the one path every payer reads. Uses `formatMoney`.
- **MOBILE MONEY HAS A RECOVERY SWEEP** (`MobileMoneyService.recoverPending`,
  hourly BullMQ + `POST /payments/mobile-money/recovery/run` behind
  `fee.reconcile.run`). A mobile-money callback is unsigned, delivered ONCE,
  best-effort, and is the only thing that says a payment succeeded — lose one and
  the payer is debited while the invoice stays open FOREVER. The card rails had a
  reconciliation sweep for exactly this; mobile money, the less reliable rail, had
  none, and no contract test would ever find it. Each adapter implements
  `getStatus` (Daraja `stkpushquery`, MTN `GET /requesttopay/{id}` — which is WHY
  the X-Reference-Id had to be a derived, valid UUID — Airtel's enquiry, keyed on
  OUR id). Rules: PENDING means ask again, never settle or fail; > 3 days is
  EXPIRED (not FAILED — money may still have moved) and expiry runs BEFORE the
  rail check, or intents on a decommissioned rail never close; recovery and the
  callback share ONE `applyReading`, so they cannot disagree; one rail being down
  does not stall the others. Hourly, not daily, because a card gateway retries a
  failed webhook for days and a mobile-money rail does not retry at all.
  Migration `20261121000000` adds the `(status, createdAt)` index the cross-tenant
  sweep needs — verified as an Index Scan, not a seq scan.
- **Webhook signatures: the security properties are in `card-rails-wire.spec.ts`.**
  Paystack HMAC-SHA512s the RAW BODY (`rawBody: true` in `main.ts` +
  `RawBodyRequest`; verifying a re-serialised JSON silently breaks). Stripe
  HMAC-SHA256s `${t}.${rawBody}` and the timestamp is INSIDE the signature — the
  staleness check is the only replay protection, since a captured event stays
  validly signed forever. // GOTCHA: **Stripe sends MULTIPLE `v1` signatures
  during a webhook-secret rotation** (`t=…,v1=new,v1=old`); reading the header
  into a `Map` keeps only the LAST, so every payment in the rotation window was
  rejected as a bad signature. Accept the event if ANY `v1` matches. Both rails
  length-guard before `timingSafeEqual`, which THROWS on a length mismatch —
  unguarded, a short signature is a 500 rather than a 401.
- **Payroll packs are VERSIONED BY TAX YEAR** (`payroll-uk.ts`). UK thresholds move
  every 6 April, so a pack that hard-codes one year is a bug with a start date.
  `UK_TAX_YEARS` is a table; the year is chosen from the period being PAID (so
  re-running an old month uses that month's rules); a period with no rates is
  REFUSED, never computed with the nearest year. Adding a year = one array entry,
  nothing else. Three things keep it from rotting: payslips are SNAPSHOTS
  (`breakdownEnc`, never recomputed) so history never moves; `payroll-uk.spec.ts`
  FAILS once the current date has no rates — a deliberate early warning, months
  before a school hits it; and a pack's throw is converted to a 400 in
  `PayrollService.createRun`, because "internal server error" sends a bursar to
  support instead of to whoever updates the rates. SCOPE: England/Wales/NI only —
  Scotland's bands differ and are deliberately unimplemented
  (`SCOTTISH_RATES_UNSUPPORTED`); non-cumulative (Month-1 basis), not HMRC-exact
  across a year of changing pay. Figures must be verified against HMRC before a
  real run. // GOTCHA: the STATUTORY REMITTANCE CSV — the one filed with a revenue
  authority and a pension administrator — divided by 100 and headed every column
  `(NGN)`, while the BANK EXPORT immediately beside it already asked the currency
  (`toMajor` + `currencyDecimals`) and interpolated `region.currency`. Classic
  sibling asymmetry: two exports off the same run, one right and one not. The
  figures AND the column names both follow the school's currency now. Also gone:
  an unreachable `catch` in the payslip PDF whose only body divided by 100 —
  `formatMoney` cannot throw (it falls back internally, still correctly scaled),
  so the single arm that would have been wrong was the one that could never run.
  LATENT, not live: `PAYROLL_PACKS` covers NG and GB only and `createRun` refuses
  a country without a pack, so no zero-decimal school can reach it — it would
  have gone wrong silently on the day one was added, which is the worst moment to
  find out, because the first evidence is a filing somebody has already made.
- **GDPR mode — BUILT** (`apps/api/src/privacy/compliance.*`, `data_breach_incident`,
  migration `20261119000000`, rls/100, web `/admin/compliance`). Art. 33's 72-hour
  clock runs from `discoveredAt` — when the school BECAME AWARE — which is captured
  explicitly and is **never updatable**, since a register whose start time moves proves
  nothing. Not notifying is lawful only as a RECORDED decision, so silence past 72h is
  `overdue`. Art. 34 is tracked separately (`subjectsUnnotified`): telling the regulator
  and stopping there must not read as done, and a HIGH-risk breach cannot be CLOSED
  until the people were told or a reason is recorded. The posture screen states what is
  MISSING (absent DPO, consent coverage) as loudly as what is present. Perm
  `privacy.compliance.manage`. // GOTCHA: `PRIVACY_ROLE_PERMISSIONS` in
  `permissions/privacy.ts` is ORPHANED — `role-map.ts` hard-codes the privacy keys and
  is what the seed actually reads.
- **Platform duties are LENT, not held.** `manager_admin`'s standing role is the bare
  floor (`platform.tenants.read` + `notification.read`). Every real duty —
  provisioning, onboarding triage, audit reads, account lookup/unlock, grace,
  feedback, plus a higher tier (`platform.tenants.status`,
  `platform.subscription.manage`) — is LENT by the owner for a bounded window via
  `platform_delegation` (migration `20261115000000`, rls/99, owner-only behind
  `platform.staff.manage` + step-up, never self-granted, ≤90 days, audited at grant,
  USE and revoke). The guard reads the table on a permission MISS, so a hand-back
  applies on the manager's very next request rather than when their session ends.
  THREE tiers, and the distinction is the point: `PLATFORM_STAFF_BASELINE_PERMISSIONS`
  (standing) ⊂ `DELEGABLE_PLATFORM_PERMISSIONS` (may be a role permission) ⊂
  `LENDABLE_PLATFORM_PERMISSIONS` (may be lent briefly). Impersonation,
  platform.operate, plan credentials, pricing, student records and hiring platform
  staff are in NONE of them — lending one for a week is giving it away. Deliberately
  NOT the JIT-elevation path, which is bottom-up and closed to every platform.*
  permission. // GOTCHA: narrowing the role only takes effect when the SEED RE-RUNS
  (it reconciles role→permissions with a deleteMany), and the seed needs the
  PRIVILEGED URL — the app role is SELECT-only on `school`.
- **`super_admin` holds NO standing role scope over a tenant's data.** Each service
  keeps its own "sees everything" set (`SCHOOL_WIDE_ROLES` / `ROSTER_WIDE` /
  `STAFF_WIDE`); 26 of them listed `super_admin`, each copied from the last. It was
  defence in depth rather than a live hole — a platform user's JWT carries the
  PLATFORM org's school_id, so RLS confines them to an org with no pupils, and
  impersonation mints the TARGET user's roles, never super_admin — but it became
  real the moment anyone granted super_admin inside a school. All 31 occurrences are
  gone and `test/security/no-standing-superadmin.spec.ts` fails the build if one
  returns, naming the file and constant. The supported route to tenant data is
  impersonation: step-up gated, time limited, audited against the operator by name.
  Attendance goes further — `REGISTER_COVER_ROLES` (who may TAKE a register) is
  `school_admin` only, since the register records who physically looked at the room.

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
  `ModuleEntitlementService` (foundation, TEN-MINUTE cache — `CACHE_TTL_MS =
  600_000`, not the 30s this line used to claim; invalidation fans across ECS
  tasks via `RedisPubSubService` — see Live push, which is why the TTL can be
  long, but a plan changed DIRECTLY in the database takes up to ten minutes) and returns **404** if the
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
- **TIERS REPACKAGED + ADD-ON SKUs (Aug 2026).** Each tier is now one sentence:
  STANDARD (10) *teach, register, BILL*; PREMIUM (+9) *oversight, assessment,
  engagement*; ULTIMATE (+6) *the whole pupil and the physical school*;
  ENTERPRISE (+2) *running a school as a business* — payroll and the group
  console. // GOTCHA: **FEES was in PREMIUM, so the entry tier could not raise an
  invoice — and the take-rate is earned ONLY where fees are collected.** The
  cheapest schools, of which there are most, generated no transaction revenue and
  the module that would have earned it was the upsell. The entry tier is now
  priced low DELIBERATELY and monetised by transactions. DOCUMENTS moved down for
  coherence: `reportcard.controller.ts` was gated on DOCUMENTS, so a STANDARD
  school had a gradebook it could record marks in and no way to print a report
  card — it is gated on GRADEBOOK now. CBT joined INTEGRITY (one job seen twice)
  and GAMES joined the engagement group; CERTIFICATE moved beside admissions and
  alumni, where an ID card belongs in a pupil's lifecycle.
  **ADD-ONS**: `MODULE_ADDON_PRICING` prices a single module per seat, billed
  through `overrides.enabled` at checkout, on the quote grid AND on renewal —
  before this, a per-school override was a free comp, not a product. Two rules
  keep the funnel honest and both are test-enforced for EVERY module: an add-on
  always costs MORE per module than the tier containing it, and by the THIRD
  add-on the upgrade is cheaper. `billableAddons` never bills a module the tier
  already includes, so an upgrade ABSORBS an add-on instead of stacking on it —
  the likeliest way this would have gone wrong is an operator comping a module
  and the override outliving the upgrade. `NOT_SOLD_SEPARATELY` (task, poll,
  discussion, form) is a deliberate decision, not a gap: nobody buys a polls
  module, pricing them credibly low made three cheaper than the upgrade, and
  pricing them high enough to protect the ladder was a price nobody would pay —
  so they stay tier sweeteners. // GOTCHA: `PLAN_PRICING` in code is the fallback
  for a currency with no operator `plan_price` row and had drifted to about half
  the live NGN prices, so opening a new currency would have quoted half price.
  Realigned to ₦525/750/975/1,250.
- **ADD-ON PURCHASE — BUILT, self-serve** (`AddonPricingService`,
  `module_addon_price` + migration `20270103000000` + rls/111,
  `platform_subscription_payment.addonModule`, `SUBSCRIPTION_PAYMENT_KINDS.ADDON`,
  web `AddonShop` on /billing and `AddonPricingManager` on /operator/pricing).
  A school buys ONE module without changing tier: `GET /billing/addons` quotes it,
  `POST /billing/addons/:module/init` charges it (step-up), the webhook switches
  the override on. Priced PER SEAT and PRORATED to the time left — buying three
  weeks before renewal costs three weeks — then billed in full at every renewal,
  which is wired through checkout, the quote grid AND auto-renew.
  // GOTCHA: an ADDON payment must NOT move `currentPeriodEnd` (it is a
  part-period charge; extending would hand over a free cycle) and must NOT
  overwrite `priceMinor` (the next upgrade's proration credit is computed from
  what was LAST PAID IN FULL). It behaves like TRUEUP on both counts.
  // GOTCHA: `enableAddon` is a set union, because a gateway RETRIES — a
  duplicated entry in `overrides.enabled` would be billed twice at renewal.
  Verified live end to end: shop -> checkout -> signed webhook -> `/hostels` went
  404 to 200 while `/alumni` stayed 404, period unchanged, replayed webhook left
  one entry. Operator prices them on /operator/pricing, and each row SHOWS what
  the module costs inside its tier and flags a price that undercuts the upgrade —
  it warns rather than blocks, because a deliberate loss-leader is legitimate.
- **THE TAKE-RATE IS ON**: `platform_fee_config` id `'fees'` (a SINGLETON — a row
  with any other id is invisible to `PlatformFeeService`, which cost me a probe
  to discover), 150bp capped at ₦2,000, borne by the PARENT.
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

## Revenue program (July 2026) — BUILT
Eight monetization levers on the billing/gateway rails (branch feat/revenue-program):
(1) **Fee-collection TAKE-RATE**: operator-set convenience fee (flat+bp+cap, ZERO
fail-safe default) via the Paystack split's `transaction_charge` — global
`platform_fee_config` (rls/71, plan_price posture), per-school bearer choice
(PARENT adds to the charge / SCHOOL nets less; `school.paymentFeeBearer`,
fee.manage+step-up), webhook credits the ledger with the INVOICE amount only
(`payment.platformFeeMinor` records the cut). Operator GET/PUT
`/operator/platform-fees`. (2) **Admission-form fees**: `school.admissionFormFeeMinor`
snapshot per application; public checkout at intake + retry init; webhook stamps
`formFeePaidAt` idempotently; PAID/UNPAID chips + fee setting on /admin/admissions;
fee shown on the public directory. (3) **Saved-card AUTO-RENEW**: reusable Paystack
authorization captured from the school's own charge (field-encrypted,
`school_subscription.paystackAuthorizationEnc`/`cardLast4`/`autoRenew`); dunning
sweep charges ~2 days pre-lapse at CURRENT seats (≤1 attempt/20h via AUTO-
references; declines → notice + normal dunning). (4) **Proration + TRUE-UP**:
`platform_subscription_payment.kind` (RENEWAL extends / UPGRADE restarts from now,
unused time credited at checkout via pure `prorationCreditMinor` / TRUEUP updates
seats only, never priceMinor); overview quotes `planChangeCreditMinor` + a seat
top-up (`computeTrueUpMinor`, MIN_CHARGE_MINOR floor) with one-click checkout.
(5) **Promos + AGENTS**: global `promo_code` (percent off FIRST charge, validated at
checkout, usedCount++ on settle) + `agent`/`agent_commission` (rls/72; commission
ledger DENY-ALL to the app role, unique schoolId = once-only) accrued on the first
paid sub of an attributed school (onboarding `agentCode` → provisioning stamps
`subscription.agentId`); operator Growth console manages both + payouts.
(6) **MESSAGE CREDITS**: append-only `message_credit_entry` (rls/73); bundles
(`MESSAGE_CREDIT_BUNDLES`) bought via checkout (webhook credits, idempotent);
each SMS/WHATSAPP delivery debits 1 ONLY after the gateway CONFIRMS the send
(a per-job ALLOWANCE from `balanceInTx` gates the attempt — read once and shared
out, so two metered channels can't both spend the school's last credit — and
`debitInTx` fires post-send, so a failed delivery never spends a paid credit),
empty balance fails those channels soft;
WHATSAPP channel added (enum+types+Twilio `whatsapp:`); `user.phone`
self-service on /account. **Operator oversight** (`/operator/message-credits`,
`OperatorCreditsService`): cross-tenant balance list (search + paginate, one
grouped aggregate over the privileged client, reason-split into purchased/
sent/adjusted) + a per-school ledger drill-down + a comp/debit lever
(`platform.subscription.manage`, step-up, audited — writes a normal ADJUST
ledger row via the ordinary tenant client with the GUC set to the target
school, same pattern as the subscription comp). (7) **GROUP console** (MODULES.GROUP add-on): global
`school_group(+member,director)` registry (rls/74 deny-all; operator-managed,
step-up) — DIRECTORSHIP is the authorization; /group renders cross-campus
aggregates (never PII) via privileged reads, audited. (8) **CBT exam hall**
(MODULES.CBT add-on): banks→questions (answerIndex SERVER-ONLY until a sitting
closes)→timed exams (server-sampled per sitting)→sittings (clock is server law,
auto-expire on read, auto-marks are staff-reviewed numbers — Golden Rule #8);
`cbt.manage`/`cbt.take` seeded; rls/75 (sittings never hard-deleted). Migrations
20260829–20260905, RLS 71–75, RLS-e2e cases for every new tenant table. Verified:
494 API tests, web build 78 routes.

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
student→enrolled / parent→children / staff→all scoping; PLUS CSP auto-generation:
a pure backtracking solver (`auto-timetable.ts` — MRV + step budget + greedy
fallback, exhaustively unit-tested) over per-offering `lessonsPerWeek` quotas,
`teacher_unavailability` slots (rls/77), and per-offering `preferredRoomId` hard
room constraints; preflight over-allocation diagnostics + per-lesson unplaced
reasons surface as operator evidence; POST /timetable/generate + availability
GET/PUT on the /timetable console), the Approval Workflow Engine, the Docker/Compose orchestration, and a
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
`x-stepup` header). **Maker-checker on money** (large payments at or above the SCHOOL's own
threshold and ALL
refunds post as PENDING_APPROVAL and don't move the balance until a DIFFERENT
staff member with `fee.approve` approves; separation of duties enforced),
**field-level PII encryption** (medical fields AES-256-GCM with a per-tenant HKDF
key from `DATA_ENCRYPTION_KEY` — ciphertext at rest, decrypted only for
authorized readers), and an **access-recertification report** + anomaly signals
(`/admin/recertification`) are BUILT. Cross-cutting BUILT so far: **role-scoped
analytics** (`/analytics` — attendance %, fee collection, ops counts; school-wide
for staff, family-scoped for parents/students; the grade-band AND fees stats are
single Postgres aggregates via `$queryRaw` — FILTER band counts + numeric-exact
AVG, CTE SUMs over billable invoices/POSTED payments cast `::float8` (int4 can
overflow a lifetime kobo total; int8 → BigInt breaks JSON) — proven by a
real-DB e2e in `test/analytics/`) and **NDPR data-subject rights**
(`privacy.*`: scoped + audited data export bundle, and a governed right-to-erasure
request → controller review at `/admin/privacy`). **Two-way messaging**
(participant-scoped threads; non-staff may only message staff/teachers; new
messages notify via Notifications), a **calendar** (`school_event`, ALL vs STAFF
audience), and **report-card PDFs** (pdfkit, from grades + attendance, streamed
through the binary-aware BFF; `generate()` ALSO persists the PDF into the
Document Vault (type REPORT_CARD, best-effort — a vault failure never blocks the
caller's download) so the student/guardians get an independently retrievable
copy under the vault's own scoping no matter who generated it, and the guardian
notification rides DocumentsService's upload-confirmed notify path — the alert
is never sent before real bytes exist; ReportCardModule depends on
DocumentsModule, not NotificationModule. **Per-term REMARKS** print on the card:
`report_card_remark` (one row per student+term, upserted, rls/83) carries the
CLASS-TEACHER remark — writable by staff-wide OR a teacher/supervisor of a class
the student is enrolled in — and the HEAD remark — staff-wide only; reads use
report-card scope, `generate(...,termId)` folds them into a Remarks section, and
`RemarksEditor` on the student page drives both) are BUILT. **Online payments**
are scaffolded (Paystack via `fetch`: `POST /invoices/:id/pay/init` → hosted
checkout; `@Public` HMAC-SHA512-verified webhook → records a POSTED payment on
charge.success; gracefully 503-disabled when `PAYSTACK_SECRET_KEY` is unset —
the disabled/public paths are verified, but live charging needs real creds +
outbound network). **Chargeback/dispute handling is BUILT — BOTH gateways**
(`apps/api/src/fees/disputes.*` in its own `DisputesModule` — imported by
FeesModule AND BillingModule, imports neither; `payment_dispute` table,
migration `20260913000000`, RLS `78` — no DELETE, financial record). ONE
normalized ingestion: Paystack `charge.dispute.create|remind|resolve` (tenant
from the disputed transaction's own metadata; "declined"→WON else LOST) and
Stripe `charge.dispute.created|updated|closed` (the event carries only a
charge id — `StripeService.getCharge` reads the metadata stamped onto the
PaymentIntent at checkout; `payment_intent_data[metadata]` is set at session
create for exactly this, session metadata never reaches the Charge; status
"won"/"lost" maps directly; `updated` refreshes silently). Idempotent on the
gateway dispute id. Alerts: finance (accountant/school_admin/principal) with
the evidence deadline; a `kind === "subscription"` dispute (platform revenue)
ALSO alerts the owner immediately; and `DISPUTE_ALERT_THRESHOLD` disputes per
school per `DISPUTE_ALERT_WINDOW_DAYS` escalates an OPERATOR_ALERT
(gateway-suspension risk). LOST invoice disputes tell finance to record the
matching refund. Staff track responses at `/fees/disputes` (fee.manage
everywhere — NOT fee.read, which parents hold). **Payments completion program
(July 2026) — BUILT**, six pieces on the fees rails: (1) **lost-webhook
recovery** — `gateway_event` append-only verified-webhook log (both gateways,
written BEFORE dispatch, INSERT-no-GUC + tenant SELECT, rls/79);
`InvoiceSettlementService` (`SettlementModule` — imported by Fees AND Billing,
imports neither) is the ONE idempotent-on-reference "post an online payment"
path; verify-on-return (checkout `callback_url` → `POST /invoices/:id/pay/
confirm` verifies against the gateway, metadata must match invoice+school);
daily reconciliation sweep (BullMQ + manual `POST /fees/reconciliation/run`,
perm `fee.reconcile.run` super_admin-only) lists the gateway's settled charges
over a 3-day window and posts any missing from the ledger + owner-alerts that
webhooks are unhealthy. (2) **dedicated NUBAN virtual accounts** — one
Paystack dedicated account per student (`student_virtual_account`, rls/80, no
DELETE; idempotent provisioning, guardians notified); transfers arrive as
charge.success with ONLY a customer code → privileged code→student map →
oldest open invoice via shared settlement (method BANK_TRANSFER); no open
invoice → student CREDIT balance + finance told. (3) **installments + credit**
— `invoice_installment` (tranches must sum EXACTLY to the total; states
PAID/DUE/OVERDUE/UPCOMING DERIVED from cumulative posted payments — the plan
never moves money) + `student_credit_entry` APPEND-ONLY ledger (rls/81;
balance = SUM): prepay checkout (kind=prepay), staff apply-credit (APPLIED
entry + POSTED CREDIT payment kind, atomic), overpayment→credit as
DOUBLE-ENTRY (system REFUND on source + OVERPAYMENT entry). (4) **USD
invoices via Stripe** — initInvoicePayment branches on invoice.currency; USD →
Stripe Checkout (kind=invoice), webhook → shared settlement; no split/
take-rate on the USD rail. (5–6) **fee ops** — school registry late-fee
policy (`lateFeeFlatMinor`/`lateFeeGraceDays`) + daily once-per-invoice
late-fee sweep (idempotent via marker line item) + weekly overdue-only
reminder sweep (SYSTEM principal per school); maker-checker
`invoice_adjustment` discounts/waivers (rls/82, requester ≠ approver enforced
in-service, approval posts a NEGATIVE line item capped at outstanding);
on-demand numbered receipt PDFs (`GET /payments/:id/receipt.pdf`,
404-not-403, audited); formula-guarded journal CSV
(`GET /fees/export/journal.csv`, audited). The program's WEB UI lives on the
invoice page (PaymentPlanCard / CreditPanel — visible to family even at zero
balance so prepay is startable / AdjustmentsPanel / receipt links via the
binary-aware BFF) and the finance reports page (LateFeeConfigCard step-up
save + journal export links); /help covers finance, parent and operator
flows. LIVE-VERIFIED per role (accountant/principal/parent/student/owner):
30 API checks + per-role page-render marker checks — incl. that the
adjustment REQUESTER sees no decide buttons while the principal does.
**Idle sessions are BUILT** (`apps/web/components/shell/SessionIdleGuard.tsx`,
`lib/auth.ts`): the session JWT lives 11 min and ROLLS (updateAge 60s; the
guard pings /api/auth/session every 4 active minutes); 9 min idle → blocking
60s-countdown dialog ("Continue session" extends — activity alone deliberately
does NOT dismiss it); 10 min → sign-out to `/login?next=<page+query>`, and the
middleware's unauth redirect carries the same `next` (relative-path-validated
both sides), so re-auth resumes exactly where the user was.

**Cross-cutting batch (July 2026, eight items)** — each with an RLS file + a
cross-tenant case, a scoping e2e, and role-gated web UI:
- **Notification preferences** (`notification_preference`, rls/84): per-user
  EXTERNAL-channel toggles (email/SMS/WhatsApp) + per-type mutes. The in-app
  inbox is ALWAYS created; the delivery producer filters channels through the
  pure `allowedChannels()` in `@sms/types` — ESSENTIAL types
  (PAYMENT_RECEIVED / INVOICE_ISSUED / BILLING / OPERATOR_ALERT /
  ADMIN_APPOINTMENT / ONBOARDING) ignore per-type mute but still respect channel
  toggles; NO preference row = deliver all (historical default). `/account` card.
- **Teacher cover** (`lesson_cover`, rls/85): joins APPROVED leave × the weekly
  timetable to list each dated lesson whose regular teacher is out (bounded
  62-day window). Assign a reliever — self-cover 400, double-booking (their own
  lesson OR another cover that period) 409, reliever notified. `CoverPanel` on
  /timetable; `GET /timetable/cover/mine` is the teacher's own duty list.
- **Exam logistics** (`exam_sitting`/`exam_seat`/`exam_invigilator`, rls/87 —
  seats and rosters are INSERT/DELETE only, so a change reads as a real
  remove+re-add): dated sittings in halls, auto-seat a class 1..N with capacity
  enforced (409), invigilator rosters (staff-only; assigning a student is
  refused; assignee notified). Students/parents see their OWN hall/time/seat;
  staff see their duties (both on `timetable.read`). New perm `exam.manage`.
  `/exams` page.
- **Parent-teacher meetings** (`meeting_slot`/`meeting_booking`, rls/86): hosts
  open slots (`meeting.host`), parents book for their OWN child only
  (`meeting.book`, 403 otherwise) with an in-tx capacity claim (full → 409, and
  the slot drops out of the open list); both parties notified on book/cancel.
  `/meetings` page.
- **Global search** (`SearchService`, no new table): in-tenant omnibox over
  students / staff / classes / invoices at `GET /search?q=`. Each category is
  included ONLY if the caller holds its read permission, and students are
  relationship-scoped — whole-school staff see all, a teacher their classes, a
  parent ONLY their own children and their own invoices. `GlobalSearch` in the
  AppShell header.
- **Per-school MFA policy** (`School.requireStaffMfa`): when on, login flags
  `mfaEnrollRequired` for any STAFF member (any role but student/parent;
  super_admin exempt) who hasn't enrolled — the same NON-blocking enforcement as
  the per-user mandate (session granted, web holds them on /account).
  `GET/PUT /admin/security/mfa-policy` (rbac.manage; PUT step-up + privileged
  registry write). Card on /admin/roles.
- **Verified backup/restore** (`infrastructure/scripts/`, `terraform/backup.tf`,
  `docs/RUNBOOK-BACKUP-RESTORE.md`): `backup.sh` (logical pg_dump + pruning) and
  `restore-drill.sh`, which restores into a THROWAWAY scratch DB and asserts
  pg_restore was error-free, tables+rows exist, **RLS is still enabled on every
  tenant table** (`ultimate_participant` is the one documented exemption), and
  **tenant isolation still holds** (app role under tenant A's GUC sees zero of
  B's rows). AWS Backup vault + weekly/monthly plan gives 90/365-day archival
  BEYOND the 14-day RDS PITR window.
  // GOTCHA the drill caught: a pg_dump NEWER than the server emits
  // `SET transaction_timeout`, which an older server REJECTS on restore — the
  // dump looks healthy and is unrestorable. Both scripts take `PG_CONTAINER`
  // to run a version-matched client; backup.sh warns on a newer host client.

#14 (cross-cutting) is DONE. By-role (#15) so far: **HR module**
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
### Five boot assertions, and knowing our own address
`main.ts` asserts before serving anything: `assertStorageProviderConfigured`,
`assertFieldCryptoConfigured`, `assertAuthSecretUsable`,
`assertPublicWebUrlConfigured`, `assertEmailSenderConfigured`. All four refuse only in PRODUCTION, so local work
needs no generated secrets.
The last is `publicWebUrl()` (`common/public-url.ts`), which replaced TWELVE
copies of `process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"` — Paystack and
Stripe return URLs, billing and message-credit checkout callbacks, invite links,
password-reset links, the admissions documents link, and the URL the TWILIO
SIGNATURE is verified against. Unset, all twelve fail the same way and none says
so: payers returned to localhost so verify-on-return never fires, invite and
reset links emailed to real people pointing at their own machine, and a signature
computed over the wrong URL so credit refunds stop silently. **Every symptom is
somewhere this deployment cannot see** — a payer's browser, somebody else's
inbox, a webhook that quietly stops matching — which is why it is a boot failure
and not a warning. // GOTCHA: the twelve were not even guessing consistently with
the stack — the code assumed `http://localhost:3000` (Next dev) while
docker-compose sets `http://localhost` (nginx). `publicWebUrl()` also strips a
trailing slash: `https://x//billing?verify=…` is a different URL to a gateway and
to Twilio's signature. Terraform DOES set it on the api task (checked) — this is
latent, not live. mobile-money and admissions deliberately return EMPTY and warn
rather than send half a URL; they were right and are left alone.

### An environment variable set to an EMPTY STRING is not unset
`envOrNull` / `envOr` / `envIsSet` (`common/env.ts`). `process.env.X ?? fallback`
is blind to `""`. Nullish coalescing is the CAREFUL operator — it does not treat
`0` or `false` as absent — and for env vars, which are always strings, that
carefulness is exactly wrong: the one falsy value a variable can hold is the
empty string, and it means not configured.
Nothing checked the boundary. Seven variables reach the ECS tasks from Terraform
variables declared `default = ""`, so a deployment that simply does not set one
hands the container an empty string and every `??` behind it fails to fire. Two
were live defects on the path to a real person, and one costs money:
**`TWILIO_WHATSAPP_FROM`** — `?? process.env.TWILIO_FROM` never fired, so the
fallback the comment beside it described was unreachable. The empty sender then
hit a branch that logged "no Twilio creds" (untrue) and returned `{ ok: true }`
to degrade gracefully — and `ok` is what decides whether to DEBIT A PAID MESSAGE
CREDIT. A school was charged per WhatsApp message, none were sent, each recorded
SENT. // GOTCHA: NOT CONFIGURED and MIS-CONFIGURED must not share an answer.
`ok:true` is right for a deployment with no Twilio account (the stub case) and
wrong the moment credentials are real and only the sender is missing.
**`EMAIL_FROM`** — `?? DEFAULT_FROM` never fired, so every email would carry a
blank From and be rejected. `assertEmailSenderConfigured` now refuses to boot in
production when `EMAIL_API_KEY` is set and the sender is blank OR still the
placeholder `no-reply@sms.school` — a domain this platform does not own, so the
mail fails SPF/DKIM and gets the account marked as a spammer. Terraform's
`email_from` no longer has a default at all.
Also fixed: `DATABASE_MIGRATE_URL ?? DATABASE_RETENTION_URL` (both directions) —
an empty value silently disabled retention, dunning and provisioning while the
warning named both variables as if neither were set.
Gate: `test/infrastructure/an-empty-string-is-not-unset.spec.ts` reads BOTH
SIDES — `ecs.tf` for what is shipped, the API sources for how it is read — and
fails on any `??` around a shipped variable. // GOTCHA: its first version keyed
on the empty-DEFAULT set, so removing a bad default switched OFF the app-side
check: the fix disabled the test that proved the fix. It keys on what the
deployment SHIPS instead, because anything an operator can type into a task
definition can arrive blank.

### A secret's SHAPE is not its PROVENANCE
`PUBLISHED_SECRETS` / `isPublishedSecret` (`auth/published-secrets.ts`), consulted
by both boot checks. `.env.example` shipped
`DATA_ENCRYPTION_KEY=Q5gcF3Ehy9TDmCWdhBIcu3BMCdoapo/z6xroVbv6zoE=` — a perfectly
well-formed 32-byte base64 key that passes every malformed-key check, and is
PUBLISHED IN THIS REPOSITORY (the field-crypto suite used it too). Anything a
copying deployment encrypted with it — medical records, salaries, payslips, bank
details — is readable by anyone with the source: real ciphertext, no protection.
No pattern catches that key, because it looks exactly like what it should be;
the only thing that distinguishes it is that we published it.
So both checks now ask PROVENANCE as well as shape, and NOTHING IS EVER REMOVED
from the list — a value stays compromised after the example stops carrying it,
because the deployments that copied it still have it.
`published-secrets.spec.ts` reads `.env.example` and fails if it grows another
secret-looking value that is not registered, so the list cannot fall behind the
file that creates the problem. // GOTCHA: rotating `DATA_ENCRYPTION_KEY` does NOT
re-protect existing rows — they must be RE-ENCRYPTED (decrypt with the old key,
encrypt with the new, in one process, using the app's own `field-crypto` so the
cipher is never re-implemented).

### The signing key was printed in the example file
`secretProblem()` / `assertAuthSecretUsable()` (`auth/secrets.ts`). `AUTH_SECRET`
signs EVERY token — session bearers, the ws-ticket, step-up, invite links,
password-reset links, the local storage presigns — and was unchecked beyond
"is it set". `.env.example` shipped `AUTH_SECRET=change-me-32-char-min-secret`:
PUBLISHED IN THIS REPOSITORY, 28 bytes despite its own "32-char-min" advice, and
the value the local stack was actually running. Any deployment that copied the
example — the ordinary way to start — could have a session minted for any user in
any school by anyone who had read the source, plus step-up tokens and
password-reset links. Same shape as the demo-seed password this project already
treats as a full platform compromise.
Now: production REFUSES TO BOOT on a placeholder or anything under 32 BYTES
(bytes, not characters), naming which and how to generate one; non-production
warns. `.env.example` ships an EMPTY value with `openssl rand -base64 32` — the
failure was not only that the value was weak but that copying the example gave
you a WORKING stack, so nothing forced the question. // GOTCHA: the local compose
sets `NODE_ENV=production` for parity, so this refuses to start a local stack
still on the placeholder — which is correct, and the fix is to generate one.

### A mis-set encryption key disabled encryption in SILENCE
`keyProblem()` / `assertFieldCryptoConfigured()` (`foundation/field-crypto.ts`).
A MISSING `DATA_ENCRYPTION_KEY` disables field encryption and warns — deliberate,
so local work needs no secret. A MIS-SET one did the same thing and said NOTHING,
because the warning only ever covered the unset case. Measured against the built
image, encrypting "penicillin": `(unset)` → plaintext + warning; 32-byte base64 →
encrypted; `"c2hvcnQ="` → **plaintext, no warning** (decodes to 5 bytes);
`"not-base64-at-all"` → **plaintext, no warning** (`Buffer.from(x,"base64")` never
throws, it decodes what it can). Those two are the likely operator mistakes — a
truncated secret, a placeholder, a passphrase typed where base64 was wanted — and
exactly the cases where somebody BELIEVES the key is set. 38 call sites: medical
records, salaries, payslips, bank details, loan balances.
// SECURITY: in PRODUCTION an absent or invalid key now REFUSES TO BOOT, naming
the byte count it got. Unlike a wrong `STORAGE_PROVIDER`, this cannot be repaired
by fixing the variable afterwards — the rows are already written in the clear
(Golden Rule #5). Outside production the permissive behaviour stays and BOTH
failures warn. // NOTE: medical columns are NOT `*Enc`-suffixed like the HR ones
(`bloodGroup`, `allergies`, `conditions`, `medications`) — they are encrypted by
`SisService` all the same, so a `%Enc` column search under-reports what is
protected.

### The storage provider is decided ONCE, and an unknown value refuses to boot
`usingS3()` / `assertStorageProviderConfigured()`
(`apps/api/src/documents/storage-provider.config.ts`).
`process.env.STORAGE_PROVIDER === "s3"` was written longhand in NINE places —
eight module bindings plus the conditional registration of `LocalStorageController`,
the DEV upload route. They agreed and nothing made them agree; one drifting copy
sends a module's files to a different store than its metadata assumes, or mounts
an unauthenticated write endpoint in production.
// SECURITY: it also failed OPEN. Anything not exactly `"s3"` chose the STUB, so
`S3`, a trailing space or a future `r2` wrote every upload to the container's own
disk — works in testing, survives no redeploy, gone by the time a family asks for
the document, and nothing said so. The value is now normalised (`S3` and `" s3 "`
are the same intent) and an unrecognised one REFUSES TO START at boot, before
anything is served. Verified against the built image: `""` → stub, `"s3"` and
`"S3 "` → bucket, `"r2"` → refused by name. A test fails if any file compares the
env var directly again.

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

### An approver is somebody who is still here
`holdersOf` (`apps/api/src/common/approvers.ts`) is the ONE place the platform
asks who can approve a thing — the workflow dead-end guard, the salary and
employment maker-checker, fee adjustments, and the recertification report all
read it. It now filters to `user.status = "ACTIVE"`, because exiting a member of
staff sets that status and DELIBERATELY leaves their `user_role` rows in place
(the row is employment history; auth refuses the login instead). Without the
filter it answered "who was ever given this", so a school whose only head
teacher resigned on Friday was told on Monday that its approval chain was
staffed. Deliberately NOT counting a live elevation grant: the recertification
report uses the same function to say whether a two-person rule is STAFFED, and a
control held up by a grant that expires on Thursday is exactly the thin control
it exists to name.
The undecidable-chain refusal happens at CREATE, not submit
(`assertChainCanBeDecided`). All eleven callers create then submit in SEPARATE
transactions — `requestLeave` uses three — so refusing at submit left a DRAFT
request AND the caller's own row behind: an error AND a leave application at
"Pending" that nobody could review or even submit. The submit check stays as the
backstop for a DRAFT raised while the school still had a head teacher.
`GET /workflows` marks each pending row `stalled` when nobody but the initiator
can decide its CURRENT stage — one query per distinct stage permission on the
page — and `/workflows` says so and names the fix. The guard prevents new dead
ends; a school still has to be able to SEE the ones a resignation created.

### Work is only ever given to somebody who is still here
`assertStillHere` / `whoHasLeft` / `STILL_HERE` (`apps/api/src/common/still-here.ts`)
gate every surface that hands out FUTURE work. A staff exit sets
`User.status = EXITED` and deliberately keeps the roles and the record
(`hr/staff-access.ts`); nothing on the consuming side asked. `GET /users?kind=staff`
— the picker behind every assignment screen — had NO status filter, so a teacher
who left last term went on being offered by name, and seven services took them:
cover reliever, exam invigilator, class teacher, subject teacher, task assignee,
hostel warden, transport driver, discipline assignee. The duty roster was the ONE
that got it right (it resolves through `employee.status = "ACTIVE"`), which is how
the rest became visible. The failure is not a broken screen: it is Tuesday period 3
with a reliever who does not work here, and a notification into an inbox its owner
can no longer open — so the assigner is told they were informed.
// GOTCHA: it fails CLOSED on a row with no `status` at all, which broke six
FIXTURES and no real path — every `user` row has the column, so a stub without one
models something the database cannot produce.
DELIBERATELY NARROW: reading a departed person's NAME onto a record they were part
of (a payslip, an old audit entry, last year's report card, a case history) is
untouched. A leaver vanishing from their own past is a worse bug than the one
being fixed.

### The inbox is a record, and a trigram index under RLS is not an index
`GET /notifications` is paged, filtered (`type`, `q` over title+body, `unread`)
and counted; the page says what it is SHOWING out of what MATCHES. It used to
return the most-recent hundred and say nothing — right for a queue, wrong for a
record, and the platform owner's inbox is a record: operator alerts, dunning
digests, dispute warnings and onboarding requests all land there and are looked
up months later.
Measured on 500,000 notifications for one recipient, as the APPLICATION role with
RLS in force: the list was a Parallel Seq Scan of every row that recipient ever
received (11,654 buffers, 63 ms for 100 rows); with
`notification_schoolId_recipientId_createdAt_idx` (migration `20261228000000`) it
is an Index Scan — 18 buffers, 0.12 ms. // GOTCHA: **counts do NOT get that
treatment** — `count(*)` still walks the whole inbox (27 ms plain, 42 ms filtered),
on every page load, growing every year. So counts stop at `NOTIFICATION_COUNT_CAP`
and render as "1,000+", while PAGING runs off `hasMore` (fetch one row past the
page) so the cap never becomes a wall in front of the records.
// GOTCHA, and it invalidates a claim made earlier in this repo: **a GIN trigram
index cannot serve `ILIKE` under RLS.** `texticlike` has `proleakproof = false`,
and Postgres will not evaluate a non-leakproof operator before a row-security
qual. Same query, same data, differing only by who asks: as `postgres` (RLS
bypassed) a Bitmap Index Scan, 0.9 ms; as `major_user` a Seq Scan.
`20260925000000_search_trigram_indexes` was verified the first way, so
`user_name_trgm_idx` / `class_name_trgm_idx` / `invoice_reference_trgm_idx` cost
storage and write amplification on three hot tables and were never once used —
dropped in `20261228000000`. Nothing on the privileged RLS-bypassing client
searches those columns (the operator console searches `school` and `user.email`).
Bring them back only WITH such a reader. What bounds the inbox search instead is
the same createdAt index: the scan is over the CALLER'S OWN inbox, not the table
— 0.9 ms for an ordinary one. **Measure plans as `major_user` with
`app.current_school_id` set, never as `postgres`.**

### A list that grows with a school's LIFETIME, not its size
`listInvoices` pages with `ORDER BY "createdAt" DESC, id DESC LIMIT n`, and
nothing served that order — so the finance invoice list scanned every invoice the
school had ever raised and top-N sorted it. Correct, and O(lifetime): fine in
year one, slow in year five, and the growth is invisible because it tracks how
long a school has been on the platform rather than how big it is.
Measured as the APPLICATION role with RLS in force (never as `postgres`, which
bypasses row security and plans differently), on 45,000 invoices across 2,001
pupils: default finance page **40.1 ms / 986 buffers -> 0.10 ms / 4 buffers**;
status-filtered 38.1 ms -> 0.19 ms. The new plan is O(page size) — it walks the
index and stops at the limit. Migration `20270101000000`.
// GOTCHA: ONE index, not two. A `(schoolId, status, createdAt DESC, id DESC)`
variant was built and measured alongside and the planner NEVER chose it, not
even for a status matching 200 of 45,000 rows where it should have won. An index
nothing selects is storage and write amplification on a hot table, which is
exactly what the three trigram indexes dropped in `20261228000000` were. Measure
the variant before adding it.
// GOTCHA: the first synthetic dataset gave ONE pupil all 5,000 invoices, and the
parent's own list then seq-scanned — correctly, since the index had no
selectivity. A volume test with an unrealistic DISTRIBUTION measures the wrong
thing; redistributed across 2,001 pupils it is an index scan at 0.28 ms.

### The same measurement, applied to the other big reads
Attendance, messaging and audit, measured the same way — as the APPLICATION role
with RLS in force, at volume. Two were already right and one was not, and saying
which is the point of doing it rather than asserting it.
- **Attendance register history** — `Index Scan Backward` on
  `attendance_session_classId_date_key`, 29 buffers, **1.85 ms**. Fine.
- **Audit log page** — `Index Scan Backward` per PARTITION on
  `(schoolId, createdAt)`, **0.59 ms**. Fine, and the monthly partitioning is
  doing real work.
- **Staff inbox** — the O(lifetime) shape again, and it took BOTH extremes to
  see it, because the plan depends on how many threads the caller is in. At
  100,000 threads: a user in 50 of them 0.63 ms (participant-driven nested loop,
  already fine); **the OFFICE account, in every thread, 66.06 ms — a Parallel Seq
  Scan of all 100,000 plus an external merge sort SPILLING 2.5 MB to disk.** Not
  a corner case: a general-enquiries or bursar account IS in every conversation
  and nothing archives threads. `message_thread (schoolId, createdAt DESC, id
  DESC)` (migration `20270102000000`) takes the office case to **0.38 ms** with
  no sort, and leaves the sparse case at 0.60 ms — the planner keeps its good
  plan, so nobody pays for the fix.
// GOTCHA: the dev database said 12 ms for this and looked mildly slow, not
broken. 2,601 threads is small enough that a seq scan IS the cheaper plan, so
the bad plan only appears at volume — the reason `measure on volume` is a rule
here rather than advice.
// GOTCHA: after adding the index the SPARSE case first read 9.7 ms, which looked
exactly like the regression this kind of index can cause. It was bloat from the
bulk UPDATE that built the fixture (1,399 buffers to fetch 50 rows). VACUUM,
re-measure, 0.60 ms. A benchmark must account for the churn the benchmark itself
caused.

### A paid module's controller with no entitlement tag is a free feature
CLAUDE.md listed the deliberately ALWAYS-ON controllers as PROSE — seven
categories against thirty untagged controller classes — and nothing checked it
either way. The gap it hid: `MemberScanController` sat inside `certificate/`
with no `@RequireModule` while `certificate.controller.ts` beside it carried one.
CERTIFICATE is a PREMIUM add-on, so every school on the STANDARD tier had the
ID-card scan desk for nothing. Tagging it breaks nobody — a school without the
module has never had an ID card to scan, and no live school has a single
`scan_event`. Live: STANDARD -> 404 on the scan desk and 200 on library;
ENTERPRISE -> 200.
The rest are genuinely always-on and now say so: infrastructure, the auth and
security spine, the privacy/compliance obligations, cross-cutting features with
no module key at all (search, meetings, exam logistics, directory, approvals —
which "span modules a school may or may not have"), scholarship (a growth lever,
open to every plan), and the public surface, which has no school session to
resolve an entitlement from.
Gate: `every-controller-declares-its-module.spec.ts` requires each controller to
carry a tag or be named always-on WITH A REASON, and fails on a stale entry for a
controller that no longer exists — a dangling exemption is a hole waiting for the
name to be reused. It reads the decorator run above EACH CLASS, not the file:
several files hold two controllers, which is exactly how the scan desk stayed
untagged beside a tagged sibling.
// GOTCHA while verifying: changing a plan directly in the database does NOT take
effect for up to TEN MINUTES. The entitlement cache is `CACHE_TTL_MS = 600_000`,
and the Redis invalidation that makes a long TTL safe only fires on a write
through the application. Restart, or change the plan through the operator API.

### The front door, and the one place a rate limit would lose money
Of 26 unauthenticated routes, 11 carried `RateLimitGuard`, and the pattern was
that every public POST was limited and the public GETs were not — the wrong way
round for cost. Applying for a job writes ONE row; LISTING vacancies queries the
table, uncached, once per request, for anybody. `GET /public/schools` was the
sharpest: the parent-facing directory, a `findMany` over every ACTIVE school, no
cache and no limit, while `POST /public/admissions` beside it allowed 5 a minute.
Now 60/min on `/public/schools` and both `/public/careers` reads.
**THE EXEMPTIONS MATTER MORE THAN THE FIX.** A gateway webhook must NEVER be
rate-limited: Paystack and Stripe retry on any non-2xx and a 429 IS a non-2xx, so
a limiter turns a burst of real payments into a retry storm and then into money
charged with no invoice credited; M-Pesa and MTN callbacks are delivered ONCE and
a 429 loses the payment outright. The biometric endpoint is exempt too — a gate
terminal legitimately bursts at the start of a school day and does not retry.
Somebody tidying up "unprotected public routes" would add limiters to those in
good faith, so `public-routes-are-rate-limited.spec.ts` asserts they stay
UNLIMITED as well as asserting the rest are limited. Live: 70 hits on the
directory gave 60x200 then 10x429; 30 rapid webhook posts gave 30x401 and never a
429.
// GOTCHA: the scan's first version used a fixed-size lookbehind for `@Public()`
and picked up the PREVIOUS route's decorator — it claimed
`POST /fees/reconciliation/run` and the applicant-to-staff conversion were open
to the world. Both are permission-gated. Bound the decorator RUN, never a
character count. And take the NEAREST `@Controller` above a route, not the first
in the file: `attendance.controller.ts` holds two, so the biometric route came
out under the wrong prefix and its exemption silently did not match.
// GOTCHA, found BY this change: `platform-org-not-a-school.spec.ts` matched
`@Public()[\s\S]{0,200}?@Get("…:slug…")`, so adding one more decorator pushed a
route past 200 characters and it stopped being found — the count fell from 3 to
2. Its own "did I find anything" assertion caught it. That gate now bounds by the
decorator run too, and was re-validated by padding a route with three comments.

### "Every mutation writes an audit-log entry" — checked, not assumed
It is a stated convention here and a Golden Rule for minors' data, and nothing
verified it. Resolving all 502 mutating routes to the service method each calls
found ONE real gap: `POST /public/biometric/:slug/events`. A terminal posts an
HMAC-signed batch and `staff_attendance` rows are created for real members of
staff; every OTHER write in that service is audited (kiosk clock-in, admin mark,
corrections) and this one — over a PUBLIC endpoint, on the say-so of a device —
recorded nothing. A stale clock, a drifted enrolment map or a leaked secret left
no trace of what was claimed, and staff attendance is read for lateness and feeds
pay. ONE entry per BATCH, not per event: a gate terminal posts continuously and a
row per clock-in would bury the log. Live, the row carries `unknown: 1` — a
device whose enrolments have drifted, which nothing else surfaces.
Gate: `every-mutation-leaves-a-trail.spec.ts`. // GOTCHA, three times, and every
one caught by MUTATION TESTING rather than by reading it: (1) inspecting only the
method the controller calls reported 71 offenders, nearly all false —
`markAttendance` audits inside `applyRegister`; (2) following delegation by
method NAME across files made `this.db.runAsTenant(...)` match every
`runAsTenant` in the codebase, so the gate went green for the wrong reason and
deleting the audit call it exists for did not fail it; (3) excluding plumbing
names then excluded genuine service methods called `create`/`update`. It resolves
the injected property to its CLASS to its FILE. And it walks controllers and
services only — reading all 440 sources into memory aborted the whole suite on
the Node heap under `--runInBand`.
Exemptions are decisions, mostly "the row IS the record": gateway webhooks
(`gateway_event`, written before dispatch), append-only ledgers, inbox reads, and
manual sweep triggers — those are wrapped in `jobRuns.record(...)`, whose
immutable JobRun row carries who, when, how long and what it returned, which is a
fuller trail than an audit line. That one is a RULE in the gate, not sixteen
identical exemptions.

### The weaker action re-authenticated and the stronger one did not
Step-up guards 53 of 502 mutating routes, which is right — asking for a password
before every invoice line trains people to type it without reading. What is not
right is applying it INCONSISTENTLY WITHIN ONE PERMISSION, and three cases had
the gate on the weaker action:
- `rbac.manage` — toggling the school's MFA POLICY needed step-up; **granting
  somebody the PRINCIPAL role did not.** Only junior-admin-tier grants are
  maker-checker; every other role was a direct audited write, and a role grant is
  the classic escalation lever step-up exists for.
- `platform.user.credentials` — resetting one user's password / MFA / status
  needed it; **switching MFA OFF for a WHOLE ROLE across a tenant did not**,
  which is strictly the larger act.
- `platform.subscription.manage` — comping message credits needed it; **granting
  a tenant a plan, a status and a paid period did not.**
Live: `POST /admin/users/:id/roles` granting `principal` went from 201 to **403**
without a step-up token, and still returns 201 with one.
// GOTCHA: `OperatorUsers` already sent the header on every call via
`sendWithStepUp`, so the operator half was a server-only change — the UI had been
asking for re-auth the server never demanded. `UserRolesManager` and
`SubscriptionManager` used a bare `fetch` and needed the web side changed too;
gating a route whose UI does not send the header just breaks the screen.
Gate: `step-up-is-consistent-within-a-permission.spec.ts` extracts every mutating
route with its permission and decorators and fails when a permission holds both
gated and ungated routes, unless the ungated one is named with a reason. It does
NOT demand step-up everywhere: 33 routes are exempted, each with why (daily work,
already maker-checker, or the restrictive direction — revoking authority should
never be harder than granting it).

### Two producers of the same telemetry, one consent-gated and one not
Golden Rule #5 binds behavioural telemetry on minors to NDPR consent, and
`IntegrityService` enforces it carefully: `ingestClientSignals` refuses to
persist without consent AND without the assessment's monitoring flag, and
`runDetection` re-checks consent so anything captured before a withdrawal is
never analysed. `CbtService.recordIntegrityEvents` writes the SAME
`IntegritySignal` table with the SAME two types — PASTE and FOCUS_LOSS,
client-observed, about a child sitting an exam — and the service had no consent
dependency at all. A rule enforced in the module it was written in is not
enforced.
Found by sweeping every write to the three telemetry tables and asking which
passes the gate: four did, one did not. DROPPED, NOT REFUSED — the pupil goes on
sitting the exam and the endpoint answers normally, because withholding consent
for monitoring must never cost a child their paper.
LATENT: `detector='cbt-exam-room'` has no rows, so nothing needs correcting.
Retention was FINE all along — the purge deletes by `{schoolId, createdAt}` with
no submission linkage, so exam-hall rows were always inside the window even
though nothing gated their creation.
Gate: `every-writer-of-telemetry-asks-for-consent.spec.ts` scans every write to
`integritySignal`/`submissionTelemetry`/`submissionDraft` and fails unless the
writer consults `hasIntegrityConsent` or is exempted BY NAME with a reason.
`autosave` is the one exemption: a draft is the pupil's OWN WORK saved so they do
not lose it, refusing it would cost a non-consenting child their essay, and the
ANALYSIS of drafts is separately gated at detection time.

### The bundle said COMPLETE and read 8 of the 33 tables keyed on a pupil
`collectStudentBundle`'s `coverage` manifest exists to remove one ambiguity — a
recipient cannot otherwise tell whether `medical: "(not included)"` means no
record or no permission. The SAME ambiguity was left one level up: ten named
sections, one exclusion, `complete: true`, and no mention that the school also
holds, keyed on that pupil's own id, the class teacher's written REMARKS, ratings
of their CHARACTER, subject choices, who it records as their guardians, money in
their name, a bank account issued for them, their own consent records and their
accessibility exemptions.
Remarks and trait ratings are the sharpest case: OPINION data, which a right of
access covers as squarely as fact, and which the family already reads on every
report card — so withholding them protected nothing and made the bundle wrong.
Now 18 sections and 9 excluded CATEGORIES, each with a reason a reader can act on
("ask the school's data controller for X"). Live on a real pupil, the bundle
gained their guardian link and their own consent record.
Gate: `every-student-table-is-accounted-for.spec.ts` derives the student-keyed
models from the Prisma schema — the way the RLS coverage meta-test derives its
tables from `pg_class` rather than counting by hand — and fails unless each is
either exported in a named section or excluded with a stated reason, AND that
bucket is one the artifact actually declares. Validated by adding a new
student-keyed model and watching it go red.

### The right to erasure reached the homework and not the birth certificate
`reviewErasure` erased `Submission.fileKey` — assignment uploads — and nothing
else. A child's birth certificate, immunisation record and passport photograph
are supplied through `DocumentSubmission`, and stayed in object storage while the
request read APPROVED and the audit row said the files were erased.
Two ways they attach to one child and BOTH are needed: `STUDENT` (keyed on the
pupil) and `ADMISSION_APPLICATION` (keyed on the application, reached through
`convertedStudentId`, the link that exists so the two records are not orphans).
No other path covered them either — `purgeRejected` sweeps REJECTED applications
on a timer, so an ENROLLED pupil's supplied documents were reached by nothing.
LATENT, not live: `document_submission` has no rows yet, so no real erasure has
under-delivered. It would have gone wrong the first time a school used the
supplied-documents flow, and the evidence would have been a regulator's question
the school answered wrongly in good faith, from its own audit log.
**WHAT IS KEPT IS NOW COUNTED AND EXPLAINED.** Document Vault entries (report
cards, receipts, certificates) are the SCHOOL's record and stay, on the same
reasoning as the retained submission row and grade — a defensible decision and a
bad secret. The audit row carries `retainedVaultDocuments` + `retainedReason`,
and the review screen now says so at the moment of signing rather than leaving it
in a log somebody has to go and find. Live on a real pupil: `0 erased,
6 school records retained`. Same rule as the exeat sweep and the alumni
broadcast — report what you did NOT do.

### The replica answers a read only if it can answer it correctly
The read/write split routes 103 paths to `DATABASE_REPLICA_URL`, and Terraform
already provisions replicas and wires that variable into ECS — with nothing
checking whether the standby had caught up. Proven against a real streaming
standby with replay paused: a teacher POSTs a leave request (201, committed) and
their own approvals list comes back EMPTY. From their side the system lost it,
and the natural next action is to submit it again.
`ReplicaRouterService` (foundation) decides, cheapest disqualifier first: no
replica → primary; lag past `REPLICA_LAG_THRESHOLD_SECONDS` (5) → primary for
EVERYBODY until it recovers; this user wrote and the standby has not replayed
that far → primary for them alone; otherwise the replica.
**LSN-based, not time-based.** "Primary for N seconds after a write" is wrong in
both directions — too weak (a standby can lag for minutes) and too strong (it
forfeits the replica when the standby caught up in 20 ms). A write records
`pg_current_wal_lsn()` AFTER commit (before commit is a position that does not
include our own commit record — the same stale read, one statement early); a read
compares it with `pg_last_wal_replay_lsn()`. The note lives in REDIS, not memory:
the write and the read after it are two requests and land on different ECS tasks.
SESSION consistency, per user — "read everyone's writes instantly" would route a
whole school to the primary while anybody in it is typing.
Cost: `txid_current_if_assigned()` inside the tx says whether it WROTE (0.068 ms
vs 0.063 ms for `SELECT 1` — one round trip), and the whole block is skipped when
no replica is configured. // GOTCHA, and it took a real standby to see it:
`now() - pg_last_xact_replay_timestamp()` is **NOT lag** — on an IDLE primary it
grows without bound while the standby is byte-for-byte identical (measured: 14 s
"behind" with receive = replay = the primary's current LSN), so a 5-second
threshold disables a healthy replica every quiet hour. Compare
`pg_last_wal_receive_lsn()` with `pg_last_wal_replay_lsn()` instead.
Visible on `GET /health` and as `db_replica_lag_seconds` /
`db_replica_degraded` / `db_reads_routed_total{target,reason}`; the `reason`
label separates "you just wrote" (normal) from "replica lagging" (alert).
**CROSS-REGION WRITE CONFLICTS ARE NOT SOLVED, because they cannot happen.**
There is ONE writer; a replica is physically read-only and refuses a write rather
than merging it, so conflict-resolution code could never run. Deliberate: last-
write-wins on an invoice balance is a lost payment, and on an approval chain it
is an approval nobody gave. If write latency ever demands more, the answer is
TENANT PINNING — every table already carries `school_id` and a school's rows are
only ever written by that school, so giving each school a home region makes
conflicts impossible by construction rather than repaired afterwards. Order:
regional read replicas → Aurora write forwarding (still one writer) → tenant
pinning. Multi-master is deliberately not on that list. See
`docs/RUNBOOK-INCIDENT-RESPONSE.md` §5.x and §5.y.

### One request body of 339 was never validated
"All API inputs validated at the boundary" is a stated convention and 334 of 339
`@Body` parameters follow it. Four of the rest are deliberate: three gateway
callbacks whose shape the PROVIDER owns (parsed defensively, settled from our own
records, never from what the caller sent — a schema there would reject a rail's
real payload and lose money) and the dev byte-upload stub.
The fifth was ordinary: `POST /members/scan/:code` hand-checked `purpose` and did
not check `note` at all. Measured live: `note: {a:1}` returned **HTTP 500** —
`note?.trim()` on an object throws, so a client mistake became an internal error
with a stack trace and a Sentry event — and a **90,000-character note returned
201 and landed in `scan_event`**, append-only, on the busiest desk in the school,
a table this codebase already sized at tens of millions of rows. Both 400 now,
capped at 500 like every other note field, purposes taken from `SCAN_PURPOSES`.
// GOTCHA worth keeping: the lesson is not "add a pipe". A hand-rolled check
covers what its author was thinking about — `purpose` was validated because it
drives a BRANCH, `note` was not because it is only STORED. Stored is where the
damage was.
Gate: `every-body-is-validated-at-the-boundary.spec.ts`, exemptions named with
reasons and each required to name a file that still exists.

### A broken bar where the naira should be
`formatMoneyPdf` / `toWinAnsi` (`@sms/types/currency.ts`). Found by reconciling
a PAYSLIP against the database — the arithmetic was perfect (200,000 + 30,000 =
230,000 gross; PAYE 21,942.67 + pension 18,400 + co-op 5,000 + loan 20,000 =
65,342.67; net 164,657.33, matching the stored run to the kobo; pension exactly
8% of gross). The figures were right and the CURRENCY SYMBOL was not.
**pdfkit's built-in fonts are WinAnsi — one byte per character — and `₦` is
U+20A6, for which WinAnsi has no room. pdfkit silently wrote its LOW BYTE:
0xA6, the BROKEN BAR.** Verified by decoding the content stream of a real
payslip: bytes `20 A6 32 30 30`. So a Nigerian school handed an employee a
payslip reading **`¦200,000.00`**, and handed a parent a fee receipt the same
way. `formatMoney` was doing its job — the symbol simply cannot be drawn.
**IT IS NOT ONLY THE NAIRA**, and that is what makes it a class rather than a
glyph. The CFA franc renders `F CFA` with a NARROW NO-BREAK SPACE (U+202F) in
every locale — eleven of the catalogue's African countries — and a FRENCH locale
uses U+202F as the GROUPING separator for every currency, so a francophone
school's documents broke whatever it billed in. Only `$` and `£` were ever safe.
The fix is the ISO CODE plus ASCII separators — "NGN 200,000.00" — not a font.
Embedding a Unicode face would carry a font file and its licence into every PDF
the product prints, to draw one glyph; and the code is less ambiguous anyway on
a platform that bills in several currencies. The payslip already had to say
"Figures in NGN" at the bottom, which is what a symbol you cannot trust looks
like. The LOCALE is still honoured for grouping and decimals, so a French school
keeps `1 234,50`.
Live after, all three documents that carry money out of the building: payslip
`NGN 200,000.00`, fee receipt `Amount received: NGN 20,000.00`, zero occurrences
of 0xA6.
// `toWinAnsi` is a WHITELIST, not a blacklist of the characters seen breaking:
the next locale added to the catalogue must not be able to introduce a new
broken glyph silently. Anything unrecognised becomes a plain space — wrong-
looking at worst, never a different character that reads as data.
// The gate asserts renderability for ten market/locale pairs AND asserts that
the SYMBOL form is still unrenderable — without that second half it would pass
for a formatter that changed nothing, and the reason for the change would be
unrecorded.


### Six definitions of one child's attendance rate
`attendanceRatePct` (`@sms/types/attendance-rate.ts`). Found by generating a
report card and reconciling every figure on it against the database — the
subject totals, the term average (647/9 = 71.89), the cumulative (1900/27 =
70.37), all nine annual averages and every grade band all checked out. The one
number that did not have a single definition was the attendance rate.
```
present + late            report card (the printed artifact), analytics, parent
present + late + EXCUSED  class board, student summary, attendance rollup
```
Measured on a real pupil over one term — 54 present, 9 late, 2 absent, 5 excused
of 70 — **the report card printed 90% and the student summary computed 97%.**
Seven points, on a child's attendance, between the document a family keeps and
the screen the school reads.
// GOTCHA, TWICE, AND THIS IS THE POINT: the divergence was written INTO COMMENTS
CLAIMING THE OPPOSITE. `getStudentSummary` carried "LATE counts as attending …
Reporting it as an absence would understate attendance and contradict the report
card" — on the very line that also added `excused`, which the card never has.
The rollup went further: "LATE and EXCUSED count as attending … contradict the
report card, WHICH USES THE SAME RULE." It never has. **A comment asserting
agreement is not agreement**, and two of them had been written by people
carefully thinking about exactly this.
// AND A TEST PINNED IT. `attendance-rollup.service.spec` asserted `ratePct` was
94 for 90 present + 3 late + 1 excused of 100, under the comment "same rule as
the report card". The assertion defended the divergence it described as
agreement — the same shape as the promotion-line test that defended keying on
the current class.
// WHICH ONE IS RIGHT: an EXCUSED absence is an absence. The pupil was not in
school; the school has merely accepted the reason — which is why education
authorities report authorised absence SEPARATELY from attendance. LATE is
different: the pupil was there. So the three FAMILY-FACING surfaces were already
right and the three internal ones were not, which is the better way round to
have found it. EXCUSED stays in the DENOMINATOR: it is still a school day.
// The rate is NULL, never zero, when no register was taken — "no register yet"
and "attended nothing" are different facts about a child, the rule the report
card's own attendance block already documents.
Gate: `one-definition-of-an-attendance-rate.spec.ts` refuses any hand-rolled
formula that adds `excused`, so a seventh screen cannot quietly disagree with a
child's own report card.


### A register for a day that has not happened
`markAttendance` guarded the PAST — a term that has ended is read-only — and the
future not at all. `daysSince` goes NEGATIVE for a future date, so such a
register was not even "stale" and went straight through the maker-checker
branch. Measured live: marking a pupil ABSENT on **2026-09-10, 2027-06-01 and
2030-01-15 all answered 201.**
Two costs on their own. An ABSENT or LATE mark NOTIFIES THE GUARDIANS, so a
family could be told their child missed a day that has not come; and attendance
feeds the rate printed on the report card, where a future absence is simply a
wrong figure about a child.
**AND IT UNDERMINED THE PARTITIONING BUILT ALONGSIDE IT.**
`attendance_record` is RANGE-partitioned by month with partitions provisioned
three months ahead, so a mistyped year lands in the DEFAULT partition — **two of
those three did** — and the service's own comment says those rows "must be
migrated into a real partition before one can be added for their month". One
typo in a date field created work that only a DBA can undo.
Measured after: all three refused with 400 and a sentence naming the fix, the
DEFAULT partition back to zero.
// TODAY is still allowed — `< 0`, not `<= 0` — because taking today's register
is what the product is for. Against the SCHOOL's day (`schoolNow`), not the
server's: a register taken on a Singapore morning is not tomorrow.
// The check runs BEFORE the staleness branch, so a future date can never be
routed into maker-checker on the strength of a negative day count.


### An archive labelled with a term that held every term
`SchoolArchiveService.windowFor` + the manifest's `scopedSections` /
`snapshotSections` (format version 2). Found by checking a claim I had just
made: I told the user the archive was per-session, then noticed the one I had
produced covered the whole school.
**`sessionId` was accepted, stored on the row, written into the manifest — and
FILTERED NOTHING.** Every archive was a whole-school dump whatever it was
labelled. The tell was already in the data and I had read past it: the three
stored archives named "Term 1", "Second Term" and "Third Term" measured 1422,
1422 and 1423 KB — near-identical, because they were the same export three
times.
Two costs, and the second is worse. The daily sweep archives EVERY ENDED TERM,
so fifteen years is **45 copies of the school's entire history, each larger than
the last** — at today's 90 MB and growing, hundreds of gigabytes of
near-duplicate for one school. And a reader opening "Third Term 2026" in ten
years got a document that MISREPRESENTED ITSELF: the whole school, including
years either side of the one on the label.
Measured after, same school: whole-school **90.61 MB**, one term **0.92 MB**.
Scoping a session took enrolments 930 -> 1, invoices 14 -> 2, workflow requests
2 -> 0 and the audit log 24,549 -> 3,341.
// WHAT IS SCOPED AND WHAT IS NOT IS NOW DECLARED, because the alternative is
the ambiguity the student export bundle's `coverage` manifest already removed
one level down. `scopedSections` are bounded to the window; `snapshotSections`
(students, profiles, staff, payroll) are a point-in-time picture as at
`producedAt` and say so — a roster has no term, and scoping it to one would
produce an archive missing the very people its other sections are about.
// SUBJECT RESULTS ARE SCOPED ON THEIR OWN COLUMNS, not on a date window: a
result carries the term and session it belongs to, so it is exact rather than
inferred from when somebody happened to type the mark.
// A TERM IT CANNOT BOUND IS REFUSED, never silently widened — that is the
defect being replaced. The sweep therefore EXCLUDES undated terms and reports
them as `undated` rather than failing on the same rows every night, which is how
a log teaches its reader to ignore it.
// GOTCHA: **the sweep passed `termId` from the day it was written and the HTTP
schema never accepted it.** So a term could only ever be archived by the timer;
asking for one by hand quietly widened to the session — which, before this, was
the whole school anyway, so nothing looked wrong. Verified after: a hand-made
term archive reports `coversLabel: First Term, 2026-09-07 -> 2026-12-18`.
// Archiving an already-archived term is a 409, which is right and is what the
unique key exists for.


### A backup a school can actually take away
Asked whether the fifteen-year archive means a school can put its record on an
external drive. Driving it end to end found THREE defects in a row on that one
path — and **every status along the way was a success**, which is what made them
invisible: 201 create, 201 for the URL, 200 on the fetch, and the file you got
was not your file.
1. **IT TIMED OUT.** `POST /privacy/archives` answered 500 after 5,033 ms with
   "Transaction already closed". The attendance section paged with OFFSET over
   `createdAt`, which HAS NEVER CARRIED AN INDEX, re-sorting 173,701 rows on
   each of 174 pages — an external merge sort per page. No school large enough
   to need an archive could produce one, and the three archives already stored
   read `attendance: 0`. PRE-EXISTING, not caused by the partitioning: the old
   single table had no `createdAt` index either.
2. **IT THREW ON A BIGINT.** `payroll_run.totalGrossMinor` is int8 —
   deliberately, because "int4 can overflow a lifetime kobo total" — and
   `JSON.stringify` throws on one. Any school that had ever run payroll was
   blocked at the last step, after all the work.
3. **IT RETURNED THE WRONG BYTES.** The stub storage route returned the Buffer
   bare under `passthrough`, so Nest JSON-SERIALISED it:
   `{"type":"Buffer","data":[123,10,…]}` — **304,025,549 bytes for a 90.61 MB
   archive**, and a checksum that could never match. A separate one-character
   bug rejected it earlier anyway: `KEY_SHAPE` allowed no dot, and the archive
   is the ONLY key in the app carrying an extension.
After, measured live: create 201 in 13.1 s, 90.62 MB, download 95,020,224 bytes,
**sha256 EQUAL to the recorded checksum**, 173,701 attendance rows, nothing
truncated, payroll totals exact.
// THE FIXES. Attendance is walked BY MONTH — the table is now partitioned on
`date`, so a month prunes to one partition and is read whole: no sort, no
offset, O(rows) instead of O(pages x rows). `runAsTenantReadOnly` takes an
optional `timeoutMs` (with `maxWait` raised alongside, or it would still fail
waiting for a connection) and the archive asks for 120 s — granted PER CALL,
because a long transaction holds a snapshot open and blocks vacuum, so the
caller must decide the trade is worth it rather than the default. BigInt
serialises as an exact decimal STRING, never a number: a JS number cannot hold
what an int8 can, and silently rounding a payroll total inside a fifteen-year
artifact is worse than failing loudly.
// GOTCHA the widened key shape nearly introduced: `[a-zA-Z0-9/_.-]` happily
matches `..`, so the traversal guard is kept EXPLICIT beside it rather than
expressed in the character class. Verified: a `../../etc/passwd` probe still
answers 400.
// GOTCHA in my OWN fix, caught by a test rather than by reading: `rows.push(
...batch)` passes every element as an argument, and a month is tens of thousands
of rows — `RangeError: Maximum call stack size exceeded`. The helper it replaced
only escaped it because its pages were a thousand rows.
// Why no test caught any of the three: they are all functions of VOLUME, and a
fixture holds a handful of rows. `a-backup-a-school-can-actually-take.spec.ts`
pins the properties; the round trip itself is proved on the running stack.


### Fifteen years of registers, and the only table with no way out
`attendance_record` is RANGE-partitioned by month on a denormalised `date`
(migration `20270110000000`), provisioned by the same daily job that keeps
`audit_log` ahead of itself.
Asked what a school does after fifteen years — download everything, free space,
stop the lag. Investigating it first was the point, because two thirds of the
answer turned out to be **no change needed**: `SchoolArchiveService` ALREADY
produces a per-session artifact covering eleven sections, and most hot reads are
ALREADY O(page) rather than O(lifetime) — invoices 0.10 ms at 45,000 rows,
notifications 0.12 ms at 500,000, the register history 1.85 ms, the audit log
0.59 ms. Deleting the institutional record to save milliseconds would trade a
legal obligation for a page load, and the app role deliberately cannot: it holds
DELETE on 76 of 204 tables.
**WHAT WAS ACTUALLY WRONG was the one table nobody had a plan for.**
`attendance_record` was 201 MB — the largest in the product, roughly 2.85 M rows
per 1,000-pupil school over fifteen years, one row per pupil per school day —
with NO retention path of any kind, while the archive already captured it. A
school archived its register and then kept every row for ever regardless.
**PARTITION, NOT DELETE, and the reason is already measured in this repo:**
VACUUM never shrinks a btree, and retention churn once left 1,026 MB of indexes
where 534 MB was needed — `attendance_record_sessionId_studentId_key` itself
went 409 MB -> 8.4 MB on a REINDEX. Freeing space by DELETE trades one problem
for another. DETACH is metadata-only. Measured on the real stack: detaching one
month released **11,700 rows instantly**, data fully intact in the detached
table, ready to archive or drop.
Results, all measured: **173,701 rows preserved exactly** (the copy asserts its
own row count before dropping the original); **201 MB -> 69 MB**, because the
rebuild dropped accumulated bloat; a windowed read went from scanning **13
partitions at 1.09 ms to 1 at 0.09 ms** — and the old shape scanned EVERY
partition, so it degraded with the school's age while the new one is constant;
all 221 migrations still replay from scratch on a fresh database.
// WHY A DENORMALISED DATE. Postgres can only partition on a column of the table
itself and the school day lived only on `attendance_session`. It is functionally
determined by `sessionId` and never changes, so a row can never MOVE between
partitions — verified across all 173,701 rows: zero date/session mismatches. It
also removes a join from every windowed read, which is what lets Postgres prune.
// THE UNIQUE KEY GAINS THE PARTITION KEY, and that does not weaken it.
Postgres forces it, so `(sessionId, studentId)` becomes `(sessionId, studentId,
date)` — and since the date is fixed by the session there is no second date the
pair could have. The raw upsert's ON CONFLICT target moved with it; verified
live that a correction still updates one row rather than inserting a second.
// NO DROP POLICY IS INTRODUCED, deliberately, and it is the same line the
audit_log migration drew: how long a school's register is kept is a POLICY
decision with legal weight, not a refactor. This makes executing that decision
instant when it is taken.
// GOTCHA: the RLS sentinel. `docker-entrypoint.sh` applies each rls/*.sql keyed
on that file's LAST policy — and for `08_attendance_rls.sql` that sentinel IS
`attendance_record_update`. Recreating the table without recreating the policies
IN THE MIGRATION would leave the file skipped and the table with no RLS at all.
Verified after: school A sees 173,701 rows, school B sees 0, and the app role is
denied direct access to a partition.
// GOTCHA, twice in two sessions: applying a migration BY HAND before the
container rebuilds makes `migrate deploy` fail (42P01 here, 42701 last time) and
the API will not boot. Let the migration be the thing that applies it.
// A DEFAULT partition means a register can NEVER fail to save — and that safety
net is the risk, so the daily job counts BOTH tables' default partitions into
the one `failed` number the operator console reads. A healthy audit log cannot
hide a stalled attendance month.


### Is it accurate and efficient? — measured, and one of the answers was no
Asked of the funds-by-department report the moment it shipped. Both halves were
worth asking, and both found something.
**ACCURATE — after a leak was closed.** Reconciled against the raw tables and
the figures matched exactly. Then the two cases the reconciliation could not see
were CREATED rather than reasoned about: an invoice carrying a posted payment
and NO line items, and one whose lines are waived to zero. Both had no
denominator to apportion by, so both dropped the payment on the floor —
**₦5,000 seeded live and the collected figure did not move.** A finance report
quietly worth less than the bank. A `stranded` arm surfaces them as
UNATTRIBUTED, a number somebody can go and look into rather than one that is
simply absent.
// GOTCHA: **the unit tests asserted the SQL's TEXT and could not catch a
comma.** A missing one after the `paid` CTE shipped a 42601 into a running stack
with every assertion green. `revenue-by-source.e2e-spec.ts` EXECUTES the query
against a real Postgres and reconciles: per-department billed, a mixed bill's
payment split 60/40, the stranded payment counted, a CANCELLED invoice excluded,
and the totals equal to the rows that produced them.
// GOTCHA, the same trap this file already records: a backtick inside an SQL
comment CLOSES the template literal. Written down once and walked into again.
**EFFICIENT — no, and then better.** Measured as `major_user` with the tenant
GUC set, on ten years of a school (60,015 invoices, 72,271 lines, 45,141
payments): the shipped query was **1,328 ms**. It aggregated line items by
(invoice, source) and then re-aggregated to per-invoice — 180,000 intermediate
rows to return four. Grouping the final result directly by (currency, source)
and joining per-invoice scalars gives **725 ms**; the `stranded` arm costs 520
of the remaining 1,197 ms and STAYS, because the alternative is the leak above.
// THINGS THAT LOOKED BETTER AND MEASURED WORSE, all rejected on numbers rather
than taste: a WINDOW FUNCTION instead of the second aggregate (2,522 ms); a
`scoped` CTE referenced three times, which materialised (2,655 ms); an anti-join
with a correlated EXISTS over the CTE (2,394 ms).
// GOTCHA in my own fixture: the first volume seed gave EVERY invoice three
sources, making every invoice mixed. That is not a school — it is the worst
case. Reshaped to ~85% single-source and the honest numbers are the ones above.
The same trap as the pupil who was given all 5,000 invoices.
// AND AN INDEX I HAD JUST SHIPPED WAS DEAD. `(schoolId, source) WHERE source IS
NOT NULL` was added on the assumption that grouping by source would use it. The
plan never mentions it and `pg_stat_user_indexes` reports **zero scans** — the
report GROUPS BY source and never FILTERS on it. Dropped in `20270109000000`.
Two covering indexes were then built and measured — about a tenth, and the
`payment` one never chosen at all — and NOT added, the same conclusion the
invoice-list index reached.
// WHERE THE CEILING IS: an ordinary school reads in tens of milliseconds; this
is O(the school's LIFETIME) and will grow with its age, because the collected
figure needs each invoice's own total to apportion against. `from`/`to` brings
ten years to 826 ms for one session.


### Funds separated by the part of the school that raised them
`FEE_SOURCES` / `invoice_line_item.source` (migration `20270108000000`),
`FeesService.revenueBySource`, `GET /fees/revenue-by-source` (`fee.manage`),
`RevenueBySource` on /fees/reports. Asked for: what boarding, transport, the
library and academic fees each bring in, separated.
Hostel rent, transport fares, library fines and tuition all land on the SAME
`invoice_line_item` table — deliberately, so a family gets ONE bill and ONE
balance rather than four. The cost was that "what did boarding bring in this
term?" had no answer anywhere in the product.
// GOTCHA, and it decided the whole design: **the only thing that LOOKED like an
answer was the line's `description`, and attributing money by it would have been
worse than having no report.** Hostel writes `input.description ?? "Hostel
rent"` and transport `input.description ?? "Transport fare"` — OPERATOR-SUPPLIED
FREE TEXT. Proved on the running stack by raising the two runs with the
descriptions a real bursar would type, "Boarding — Michaelmas" and "Bus pass —
Michaelmas": neither contains the word Hostel or Transport, and both are
attributed correctly, because the source is RECORDED BY THE MODULE THAT RAISES
THE CHARGE and never inferred afterwards. Six creation sites, all stamped;
`funds-by-department.spec.ts` fails on a seventh that forgets.
**BILLED IS EXACT; COLLECTED IS A STATED CONVENTION.** A payment settles an
INVOICE, not a line, so on a bill mixing tuition and rent a part payment does
not say which part it paid. Each posted payment is apportioned pro rata by line
amount, and `mixedCollectedMinor` reports how much of the figure rests on that.
// GOTCHA: I wrote that mixing was rare — "most invoices carry one department,
since the hostel and transport runs raise their own" — and the live data said
otherwise within a minute of the first probe: paying ₦2,300 on one hostel
invoice returned ₦1,500 hostel and ₦800 transport, because the runs APPEND to a
family's existing DRAFT invoice when there is one and only raise their own when
there is not. That is the right product behaviour, and it makes mixing ordinary:
**19 invoices carrying more than one department against 25 that did not.** So
the apportioned share is a material number the page states, not a footnote about
a corner case. A plausible sentence corrected by a measurement.
// PER CURRENCY, one table each, never summed — invoices carry their own
currency per row and this platform bills USD through Stripe beside a school's
local rail. Live: NGN and USD reported separately.
// A line written before this column existed is `UNATTRIBUTED`, its own row, and
NOT folded into tuition: `COALESCE(source, 'TUITION')` would have put invented
figures into a finance report and nothing on the page could have shown it. Live
on the demo tenant the whole history reads "Not attributed", which is true.
// ADJUSTMENTS get their OWN source rather than negative-tuition: a department's
billed figure should not move because somebody granted a waiver against a mixed
invoice, and "what did we give away?" is a question a bursar asks directly. Late
fees likewise — charged by the sweep, not by any department. CANCELLED invoices
are excluded (an unissued bill is not revenue) and a REFUND subtracts, exactly
as the invoice balance treats it.


### The person driving the bus does not need to know what each family pays
`canSeeFare` (`transport.service.ts`), `TransportAssignmentDto.fareMinor:
number | null`. Probed the two roles this project scopes most tightly — the
driver ("read-only own vehicle") and the warden ("their own hostel") — and the
ROW scoping is right, measured rather than assumed: the demo school has 6
vehicles and 30 seat assignments, the driver drives 3 and sees exactly the 15 on
those; 6 hostels and 19 allocations, the warden runs 3 and sees 11. Parents,
students and teachers get 403.
What every one of those 15 rows carried was `fareMinor` — what that child's
family is charged for the seat. Fares vary per stop and per route, so it is a
comparison BETWEEN FAMILIES, shown to the one role scoped to reading a vehicle.
**THE WARDEN IS THE CONTRAST THAT MAKES THIS A BOUNDARY AND NOT A MATTER OF
TASTE.** They see `rentMinor` on their boarders and that is CORRECT: they hold
`hostel.manage`, and allocating a room IS setting the rent. The driver holds
`transport.read` and nothing else — and is the ONLY role in the whole map that
reads transport without either managing it or reading fees, which is what the
gate asserts rather than a hand-kept list of who is allowed.
Live after: the driver's 15 rows come back with `fareMinor: null` and their
names, routes, stops and statuses unchanged — everything the job needs; the head
driver still sees 30 rows at ₦800.00. `showFare` is a REQUIRED parameter on the
mapper, so every caller had to decide rather than inherit the old answer.
// The same probe is worth repeating on any role added to `transport.read` or
`hostel.read`: scoping the ROWS correctly is the easy half, and it is the FIELDS
on a correctly-scoped row that go unexamined. The scan desk already had this
right — "ROSTER-level fields only, never medical/PII" — and it is the same rule.


### A final month the school had already paid, paid again
`computeFinalSettlement` (`@sms/types/payroll.ts`) + `ExitService.initiate`.
The settlement pays `base × day / daysInMonth` for the leaver's final month, and
**nothing asked whether payroll had already covered it.** Most schools run
payroll before month end. On the 25th, a member of staff whose last working day
is the 28th has already received the WHOLE month — and the settlement then paid
28/31 of it AGAIN: on a ₦300,000 salary a second **₦270,967.74** for a month
already discharged, about 90% over. The arithmetic was correct for the case
where payroll had not run and silently doubled for the case where it had, with
nothing in the input distinguishing them.
`finalMonthAlreadyPaid` is now a REQUIRED parameter — a required parameter is a
search for every caller relying on the old assumption, the same trick that found
the Paystack currency sites and the payment-approval threshold ones. It is
detected from the data, not asked of the user: a FINALIZED **MONTHLY** run for
the last working day's month that produced a payslip for **this person**.
// EACH OF THOSE FOUR NARROWINGS IS LOAD-BEARING, and three of them fail SAFE in
the direction that shorts the leaver, which is the worse direction:
**MONTHLY** — a THIRTEENTH or BONUS run pays base without being salary FOR that
month (the schema comment says so); **FINALIZED** — a DRAFT run has paid nobody;
**this person's payslip** — a run existing is not the same as the leaver being
in it, and somebody who joined on the 26th is in no August run; **the LAST
WORKING DAY's month** — not today's, since an exit is often initiated in the
month after the one being settled.
// Accrued leave is NOT month-bound and survives either way. Loan recovery is
clamped at the gross, so a zeroed pro-rata recovers LESS and leaves more owed —
correct (you cannot take back money you are not paying) and already reported by
`loanUnrecoveredMinor`, which is why that field mattered.
// The flag rides on the SNAPSHOT, not just the calculation, because the
settlement is frozen encrypted onto the exit record and an approver reading
"Pro-rata final month: 0.00" would otherwise read it as "worked no days". The
panel says "that month's payroll already paid in full" beside it.
// GOTCHA in the test, not the code: `Payslip.payrollRunId` is a scalar with a
DB-level FK and NO Prisma relation — the documented pattern here that keeps the
models lean — so the run cannot be filtered through from the payslip. Two reads.
// The pure helper is tested beside the other payroll maths and the SERVICE is
tested separately, because a test on a helper proves nothing about its caller —
the seam that hid the CBT score and the report-card promotion-line bugs.


### A statutory clock that nobody was watching
`BreachDeadlineService` + `breach-clock.ts` (`privacy/`, migration
`20270107000000`, `SCHEDULED_JOBS` key `privacy.breachDeadline`, manual
`POST /privacy/compliance/breach-deadlines/run`). Found by asking the sibling
question to the erasure fix one file over: the register computes
`notifyDueAt` / `hoursRemaining` / `overdue` from the school's own compliance
regime — **and only when somebody opens /admin/compliance.**
This platform runs SEVENTEEN scheduled sweeps. It reminds HR that a staff
certificate expires in THIRTY DAYS; it chases an overdue library book, a boarder
signed out too long, an invoice past due, a lapsed subscription, a stranded
notification, a bloated index. **The one deadline actually written in law — 72
hours from becoming aware, Art. 33(1) — had no sweep at all.** A breach reported
at 17:00 on a Friday by the one person who then went on leave was a missed
statutory notification the product would not mention until somebody happened to
open a screen.
HOURLY, not daily, for the reason the mobile-money sweep gives about itself: the
window is 72 hours, so a daily sweep could first warn with four hours left, or
notice a school was late a day after it happened. Two notices per incident at
most — `deadlineNoticeStage` records which has gone, and one is sent only when
the stage CHANGES, because a notice per hour is one people learn to ignore
including on the incident where it mattered.
Live, driven end to end for the first time: 80 hours in, the register reads
`overdue=true hoursRemaining=-8 statutory=true`, the sweep returns
`{scanned:1, warned:0, overdue:1, failed:0}` and the inbox gains **"Breach
notification is PAST its statutory deadline"** naming what to record and where;
a second run returns `overdue:0`. At 12 hours left it reads **"due within 12
hour(s)"** with the exact deadline; recording a reason for not notifying drops
the incident out of the scan entirely (`scanned` 2 -> 1) and sends nothing.
// ONE DEFINITION OF LATE. `clockFor` said letting "the record and the screen
disagree about whether a school is late … is the single fact this whole register
exists to establish", so it was extracted to `breachClock` and BOTH call it,
rather than the sweep re-deriving 72 hours and drifting the day a regime is
added. The notice says "target" rather than "statutory deadline" where
`deadlineIsStatutory` is false — the same honesty the screen already carried.
// ART. 34 IS DELIBERATELY NOT CHASED. `subjectsUnnotified` is a real omission
and the posture screen names it, but Art. 34 says "without undue delay" and
fixes no hour count; putting one in a timed notice invents a deadline the law
does not set, which is the mistake `deadlineIsStatutory` exists to avoid one
field over.
// GOTCHA, and a test caught it rather than a reading: the first
`breachNoticeStage` reasoned that "`overdue` is already false when the authority
was told, so reaching here means it is still outstanding" — exactly backwards.
`overdue` is false BOTH when there is time left and when the work is DONE, so a
breach notified an hour after discovery would have been warned about at hour 48
for a duty already discharged. The sweep's own `where` filters those rows, so
nothing downstream would have shown it; the test calling the pure function
directly did. It asks outstanding-ness directly now.
// GOTCHA in the DOING, not the code: applying the new column by hand with
`ADD COLUMN IF NOT EXISTS` before the container rebuilt made `migrate deploy`
fail 42701 and the API would not boot. Drop the column, clear the failed
`_prisma_migrations` row, restart — and let the migration be the thing that
applies it, which also proves it replays.


### A tenant's data is not somebody else's cache entry
`NoStoreMiddleware` (`common/no-store.middleware.ts`) + the `/api/sms/*` proxy.
Every authenticated response went out with **no `Cache-Control` header at all**,
and a `Vary` naming only Next's RSC headers — not `Cookie`. Measured live:
`/students`, `/invoices`, `/notifications`, `/analytics/overview` and
`/hr/employees` all 200 with `cache-control: null`. A 200 GET carrying no
freshness information is HEURISTICALLY CACHEABLE by a shared cache (RFC 9111
§4.2.2), and without `Vary: Cookie` a URL is the whole key.
**LATENT AT OUR EDGE, and checked rather than assumed**: CloudFront runs
`Managed-CachingDisabled` as its ONE behaviour (no `ordered_cache_behavior` at
all) and the shipped nginx has no `proxy_cache`. So nothing this platform
operates was caching. What that does NOT cover is everything past the edge,
which the platform does not own: **a school's own network proxy**, keyed on the
URL alone, serving one teacher's `/students` to the next; and the browser's disk
cache and back-button after sign-out on a device this product is DESIGNED to
share — the `/scan` gate desk with its always-focused scanner input, and the
attendance kiosk. Golden Rule #7, and nothing is lost by it while nothing is
caching.
**TWO PLACES, and the second is the one the browser sees.** The BFF proxy
REBUILDS the header set from scratch (`const out = { "Content-Type": ct }`) and
its own comment already states the principle — "a proxy that rebuilds headers
owns them" — which is why it re-adds `X-Content-Type-Options`. Whatever it does
not name does not arrive, so the API's header alone would have changed nothing.
Live after: `private, no-store` and `Vary: …, Cookie` on all five.
// THE PUBLIC PROXY DELIBERATELY DIFFERS, and both sides now say so. Everything
through `/api/public/*` is the school directory, plan pricing and vacancy
listings — identical for every caller, personal to nobody — so it is the one
surface a CDN could usefully cache. The API sets the restrictive default at the
source; that proxy does not carry it across. Stated in both files because the
alternative is a comment claiming coverage the running system does not give,
which is the failure this repo keeps finding in its own notes.
// The gate pins the premise as well as the fix: that CloudFront's only
behaviour is still `CachingDisabled`, that nginx still has no `proxy_cache`, and
that no `@Public` controller has grown a `StreamableFile` — because the public
proxy would both corrupt a byte response (`res.text()`) and leave it cacheable.
It also re-asserts the header set the rebuild already carried, since the point
of that rebuild was a stored-XSS hole and every broken CSV export.


### The clock stopped and the family was never told
`reviewErasure` (`privacy/privacy.service.ts`). Found by RUNNING a path that had
never executed: `erasure_request` had zero rows, so the NDPR right-to-erasure
chain — raise, review, erase — had never once been driven.
The mechanics are sound and heavily worked over: the approval reaches assignment
uploads AND the documents a family supplied, what is deliberately KEPT is
counted, a failed object-store delete is written down rather than swallowed, and
`listErasureRequests` computes `dueAt` / `daysRemaining` / `overdue` /
`deadlineIsStatutory` from the school's own compliance regime.
**That clock is the point, and deciding the request STOPS it.**
`daysRemaining` goes null the moment the status leaves PENDING. So the register
read "answered inside the period" while the person who asked had heard nothing:
the outcome went to the audit log, to the approver's own screen, and nowhere
else. A right to erasure is a right to an ANSWER — that is what the deadline is
a deadline for.
**RAISING one already notified the controller**, so the loop was half-built, and
every sibling decision in this codebase closes it the other way: a meeting
request answers "Your meeting request was accepted", a scholarship tells the
guardian at each stage. Erasure was the outlier, and it is the one with a period
in law behind it.
Live, driven end to end for the first time: parent raises it (201), the
controller's queue shows `PENDING daysRemaining=30 statutory=false`, approval
returns 201 — and the parent's inbox now reads **"Your erasure request was
approved — 0 uploaded file(s) have been erased. The school keeps 14 records of
its own (report cards, receipts, certificates) as it is required to."** A
refusal reads "The school has declined the request. Reason: …".
// It says what was KEPT, not only what went. Same rule the approver's own
screen already followed: a family asking "have you deleted my child's records"
is owed the whole answer, and "0 erased, 14 retained" is a truer sentence than
a bare confirmation.
// TO THE REQUESTER, never to the pupil's guardians. Staff may raise an erasure
themselves, and telling a family about a request they did not make discloses
something they were not party to. A controller answering their OWN request is
not notified.
// The notice cannot cost the decision: the send is caught and LOGGED, not
swallowed, because the decision is already recorded and losing it to a failed
notification would be worse — but an unanswered subject is the exact failure
this block exists to prevent, so silence about it would defeat the purpose.


### Holding ₦23,300 for a school it owed ₦22,000 and $1,300
`SettlementHoldingDto.held` (`settlement-release.service.ts`, `SettlementHolding`
on /operator). A parent's card payment made BEFORE a school registered its
settlement bank lands in the PLATFORM's account, and the operator's card says
what is owed. It said ONE number: `rows.reduce((n, r) => n + r.amountMinor, 0)`
over payments whose currency it had read, one per row, three lines above — with
`currency: null` whenever there was more than one.
Measured live on the DEMO tenant, which already held both: `heldMinor 2330000,
currency null`, rendered **"Holding ₦23,300.00"**, where the truth was
**₦22,000.00 AND $1,300.00**. A payment inherits its INVOICE's currency and this
platform bills USD through Stripe beside a school's local rail, so a mixed
holding is ordinary rather than a corner case.
**THE RELEASE PATH WAS ALREADY RIGHT AND THE READ WAS NOT** — it settles one
currency at a time, refuses a release that does not say which, and stamps only
the payments it covers. Only the total added them up. And because `currency`
came back null, the web hid the release control entirely, so a mixed school's
money could not be handed over through the product at all: the card said
"release them one at a time from the API", which is not a thing an operator can
do. `held` is now a row per currency, each with its own payout button, its own
bank reference and its own record. Live after: `NGN 2200000 / 3 payments` and
`USD 130000 / 9 payments`; releasing USD left the naira owed and wrote one USD
release.
// GOTCHA, and it is the sharpest part: **the warning was already there and the
number above it was wrong.** The card printed "Held in more than one currency"
directly BELOW the added-up total. Somebody saw the case, wrote the note, and
left the figure.
// GOTCHA: **the test named the bug and then did not assert it.** The existing
case reads `it("reports no single currency rather than adding them up")` with
the comment "30000 kobo and 20000 pesewas are not 50000 of anything" — and
checked only that the LABEL went null. `heldMinor` was 50000 and nothing looked.
It asserts the amounts now, and that no total equal to the sum is produced.
Gate: a THIRD half on `a-money-total-says-what-currency-it-is`. The first two
cover a `$queryRaw` aggregate and a Prisma `_sum`; this shape never reaches SQL
at all — a `reduce` in Node over `findMany` rows. Three sites are exempt because
the rows all hang off ONE parent that carries the currency (payments of an
invoice, tranches of an invoice, deduction components of a payslip), and the
exemptions are COUNTED, not merely named — the rule this same file learned when
a bare file-level pass let a `minor / 100` formatter in later under an unrelated
entry.
// GOTCHA in the gate: it first reported line numbers computed against the
COMMENT-STRIPPED copy of each file, so every finding pointed at the wrong line.
A finding you cannot navigate to is one nobody acts on.


### A name lookup once per row
`Promise.all(rows.map((r) => this.toDto(tx, r)))` reads as ordinary mapping code
and is a query multiplier: the mapper is handed the TRANSACTION, so every row it
touches costs its own round trips. Six services did it, in three services I went
looking for and three the gate found afterwards. Measured live, before and
after, as the application role with RLS in force:
```
GET /hostels             6 hostels / 264 rooms   545 queries  327 ms ->  4   37 ms
GET /integrity/exemptions            500 rows  1,507 queries  654 ms ->  4   44 ms
GET /subject-selections            50-row page    205 queries  211 ms ->  6   32 ms
GET /transport/routes, /discussion/groups                    per-row -> 1 per table
```
**HOSTELS WAS NESTED**: `hostelDto` per hostel, and inside it `roomDto` per
room — 264 reads of `hostel_allocation` and 270 of `hostel_room` to draw one
page. **EXEMPTIONS RE-READ WHAT IT ALREADY HELD**: `list` fetched the rows and
then called `toDto(tx, r.id)`, which fetched each row AGAIN — 501 reads of a
table it had just read 500 rows from, plus 1,006 of `user`. That is the
disability-accommodations screen. **SELECTIONS WERE THE SUBTLE ONE**: four
lookups per row, and a COHORT SHARES ITS TERM AND ITS CLASS, so 49 of every 50
term reads were the same row fetched again.
// GOTCHA: the paging fix directly above this made the per-row cost matter MORE,
not less — `PromotionService.list` went from 100 rows to as many as 600. A fix
that widens a page multiplies whatever the page does per row, so the two belong
together.
Each mapper is now split: a `namesFor`/`classNamesFor`/`occupancyOf` batch
resolver, a pure `toDtoWith(row, names)`, and the original single-row `toDto`
kept for the mutation paths that genuinely hold only an id — so nothing gained
a second definition of how a row is rendered.
// GOTCHA: `availableBeds` had to be copied EXACTLY (`max(0, total - occupied)`,
clamped on the total), not re-derived by summing each room's own `available`.
The two differ once a room is over-occupied, and a list disagreeing with the
detail page it links to is its own bug.
Gate: `a-query-once-per-row.spec.ts` refuses `.map(x => this.something(tx, …))`
— passing `tx` is the tell, since a mapper needing no database would not ask for
one. It found the hostel, transport and discussion sites I had not looked at.
// GOTCHA: a test on the mapper proves nothing about its caller — the seam that
hid the CBT score and the report-card promotion-line bugs.
`a-name-lookup-once-per-row.spec.ts` drives the REAL service over 40 rows and
asserts each kind of name is resolved exactly ONCE, and that a term shared by 40
rows is asked for with one id, not forty.
// GOTCHA in the measuring, twice: `docker compose -f infrastructure/...` run
from `apps/api` fails on the relative path, and with `&&` the confirmation never
prints — so three "before" measurements were quietly taken against the FIXED
container and read 34-41 ms. The real before was 327 ms. Check what the
container is actually running (`grep` the symbol in `/app/apps/api/dist`) before
believing a before/after pair.
// GOTCHA: `pg_stat_user_tables` counters lag a request by several seconds, so a
snapshot taken immediately after a probe reports the PREVIOUS probe's reads.
Settle 12-18 s, and divide by the number of requests rather than trusting one.


### The exeat chain — a child-safety flow, driven for the first time and sound
`hostel_exeat` had no rows, so signing a boarder out of a boarding house had
never once been done. Driven end to end, and every property held:
- **REQUESTED is not OUT.** A raised exeat leaves the child in the house, and the
  overdue sweep correctly ignores it (`scanned: 0`).
- **MAKER-CHECKER ON A CHILD LEAVING.** The warden who raised it cannot approve
  it — `403 "An exeat must be decided by a different person"`. A principal can.
- **The sweep found the late boarder and alerted** (`scanned:1, alerted:1`), and
  a second run returned `{scanned:0, alerted:0}` — it does not re-alert, which is
  what `overdueNotifiedAt` is for, and returning CLEARS that mark so a SECOND
  late return is a fresh alert.
- **`overdue` IS COMPUTED LIVE, never stored** — `status === DEPARTED &&
  !actualReturnAt && expectedReturnAt < now` — with its own comment saying why:
  *"a boarder who became overdue ten minutes ago must show as overdue now, not
  after the next sweep."* The register cannot be staler than the situation.
- **`?status=OVERDUE` is a 400 naming the six real statuses**, not a silent empty
  list — the `a-filter-nobody-validated` fix holding on the very endpoint that
  entry cites ("one overdue boarder into none ... a safety statement about a
  child made by a typo").
// GOTCHA IN MY OWN PROBE, worth recording because it nearly became a false
finding: I read `?status=OVERDUE` as "the register shows 0 overdue" and started
writing it up. The probe parsed a 400 body as an empty list — `Array.isArray(j)`
false, `j.items` undefined, `?? []`, length 0. **A probe that cannot tell a
refusal from an empty answer reports the wrong one**, which is exactly the defect
found in the family-scope probe two entries up, committed by me an hour later.
Assert the STATUS before interpreting the body.
// KNOWN GAP IN THE DEMO FIXTURES, not in the product: **no boarder has a
guardian link** (`boarders WITH a guardian: 0`), so the sweep's family arm cannot
fire locally. It is implemented — `parentChild.findMany` -> `guardiansOf` ->
`family` — and the staff alert reached warden, head_warden, school_admin and
principal by name. The claim that it "alerts the FAMILY in their own words"
remains UNVERIFIED end to end for want of a fixture, and that is the honest
standing rather than a tick.

### Hiding the name is not enough while the row carries the instant
Found by driving a path that had never executed: `form` and `form_response` were
both empty, so the anonymous-survey flow had never once been used.
**MOST OF IT WAS ALREADY RIGHT**, and checked rather than assumed: an anonymous
form returns `respondentName: null`, the mapper never puts `respondentId` in the
DTO at all, and the audit row is written under `SYSTEM_ACTOR_ID` — the same care
the poll module took. `respondentId` being NOT NULL in the table is deliberate
and correct: it is what the UNIQUE `(formId, respondentId)` uses to enforce one
response per person, and it is never read back.
**WHAT IT ALSO RETURNED WAS `createdAt` AT MILLISECOND PRECISION**, one row per
respondent. This file already measured that exact channel on the poll — a vote
row and a request-log line *"thirteen milliseconds apart, so log + database
recovers not just WHO voted but WHAT THEY CHOSE"* — and closed it by withholding
`user_id` from the log ON THE VOTE ROUTE. Every OTHER request the same pupil
makes still carries their id, so a response stamped to the millisecond is the
same join from the other end.
Measured live, on a form asking pupils how safe they feel:
`{"respondentName":null,"answers":{"q1":"Not very — a boy in Year 10 keeps taking
my things."},"createdAt":"2026-08-27T10:18:12.351Z"}`. After:
`"createdAt":"2026-08-27T00:00:00.000Z"`.
// **POLLS ARE SAFE FROM THIS AND FORMS CANNOT BE, WHICH IS WHY THEY DIVERGED.**
A poll read returns per-option TALLIES — there is no per-vote row to stamp. A
form's answers are free text and staff genuinely need each one, so the ROW has to
stay and the PRECISION goes instead. Truncated to the day, which is what "when
was this survey answered" actually needs.
// THE ORDER WAS A SECOND HANDLE. `orderBy: { createdAt: "desc" }` reconstructs
the ARRIVAL SEQUENCE — the third row is the third person to answer — so an
anonymous form is ordered by `id` instead. A named form keeps newest-first,
which is what staff want there.
// UTC midnight DELIBERATELY, not the school's day: this exists to REMOVE
precision, a day either side is no loss, and reaching for the region service
would add a dependency to buy nothing. It also lands on the exact-UTC-midnight
shape `isCalendarDate` already renders as a calendar date rather than converting.

### A pupil told the classmate in front of them is "not in this school"
Found by driving a path that had never executed — `discipline_complaint`,
`discipline_entry`, `discipline_evidence` and `discipline_assignee` were all
empty, so the pupil-facing safeguarding flow had never once been used.
**THE CONFIDENTIALITY CHAIN HOLDS**, verified rather than assumed. A case filed
against a pupil: the ACCUSED gets `404` and an empty list, an uninvolved pupil
`404`, the accused's own PARENT `403`, and only staff holding
`discipline.manage` see the allegation text. The fix this file already records —
*"the accused read and dismissed the case"* — is intact.
**WHAT WAS WRONG WAS THE REFUSAL.** A pupil may only file against a CLASSMATE:
`listFileTargets` scopes STUDENT targets to their own classes, deliberately, so
that filing does not hand every child a searchable roster of 900 minors. Measured
live, a pupil with no classmates got `0 target(s)`, and naming a real pupil of
the same school answered
**`404 "The named person is not in this school"`** — about somebody standing in
front of them.
// A REFUSAL MAY DECLINE TO CONFIRM WHAT IT HIDES; IT MUST NOT MAKE A POSITIVE
CLAIM THAT IS UNTRUE. Same defect as the `403 "Invoice not found"` recorded here,
pointing the other way — that one denied a record it had just confirmed, this one
asserted a fact about school membership that is false.
// THE TWO BRANCHES STAY INDISTINGUISHABLE — "out of your scope" and "no such id"
must read identically or a pupil can probe ids for who exists — so a non-manager
gets ONE message for both. It is true in either case, discloses nothing (it
describes the CALLER's scope, not the target's existence), and NAMES THE WAY OUT:
*"You can only report someone in your own classes. Ask a teacher or the school
office to file this for you."* A manager, who has no scope to leak, gets the
plain "No such person in this school".
// THAT LAST CLAUSE IS THE POINT, not politeness. The classmate restriction means
**a child bullied by someone in another year, on the bus, or in the boarding house
cannot file at all** — and the refusal was the only place they would ever learn
that. Widening the target list would expose a roster of minors and allowing an
UNNAMED report is a schema change (`againstId` is required); both are product
decisions and neither is taken here. Telling the child there is a human who can
do it for them is the part that was missing and costs nothing.

### Global search — the probes' blind spot, checked and sound
All four probes are ID-ADDRESSED: they ask what happens when a caller already
knows a valid id. `GET /search?q=` is QUERY-addressed — you type a name and need
no id at all — so a leak there is invisible to every one of them. Probed live
across five roles on a school of 900 pupils:
```
searching "Volume" (900 pupils, none of them theirs)   parent/student/teacher/driver/librarian -> no hits
searching "Demo"   (their own child / their own pupil) parent -> 1   student -> 1 (themselves)   teacher -> 1
                                                       driver -> 0   librarian -> 0
```
Correct on every row. A parent sees only their own child, a pupil only
themselves, a teacher only pupils in classes they teach, and the two roles with
no business opening a pupil's profile get nothing at all — which is the point the
service's own comment makes: it gates on **what the DESTINATION requires**
(`student.profile.read`), not on anything that merely implies an interest in
pupils, because *"a result that cannot be opened is worse than no result: it
tells a user the record exists and that they are being refused it."*
// OBSERVED AND DELIBERATELY NOT CHANGED: the two branches disagree about
LEAVERS. The whole-school branch applies `ON_ROLL_STUDENT` (which includes
`status: ACTIVE`) and the relationship-scoped branch does not — so, measured
live on one exited pupil, **the school office finds 0 and the teacher finds 1**.
That reads backwards at first, and it is NOT obviously a defect: leavers have
their OWN page (`/students/exited`, which feeds the bursar's chase and the
transcript decision), and a teacher finding a former pupil of theirs is
defensible on the same reasoning that keeps a leaver's name on their old records.
Deciding it needs establishing whether a leaver's profile opens for each role,
which I could not settle cheaply — the demo's obvious candidates have no
`student_profile` row, so the 404 says nothing either way. Left alone rather than
shipping a guess into a read path, and written down so the next person starts
from the measurement instead of the surprise.

### The runbook's most important command, pointed at the wrong port
Four probes exist and each answers a question the unit tests cannot: route smoke
(SSR 500s), isolation (school A reaching school B BY ID through the real front
door), family scope (one parent reaching another family's child) and the
permission matrix (a role served rows from an endpoint whose permission it
lacks). **None of them is in CI** — they need a running stack and sign in through
the front door — so they are run by hand or not at all.
All four defaulted to `WEB_URL ?? "http://localhost:3000"`. **That is the NEXT
DEV SERVER; `docker compose up` serves the stack through NGINX ON PORT 80.** So
the command the incident runbook tells an on-call engineer to run —
`pnpm --filter @sms/web isolation:probe`, for the control it itself calls "the
most important test category" — answered **`PROBE ERROR: fetch failed`** against
a perfectly healthy stack, with nothing saying why.
// EXACTLY THE TRAP `publicWebUrl()` ALREADY RECORDS, for the API's twelve copies
of the same literal: *"the code assumed `http://localhost:3000` (Next dev) while
docker-compose sets `http://localhost` (nginx)"*. That was fixed in `apps/api`
and these four were not, because they live in another package. `seed-modules.mjs`
carried it too. Sibling asymmetry across a package boundary, which is the kind a
sweep of one directory never finds.
Now they default to the compose stack, and a connection failure NAMES the
variable and both candidate URLs instead of only "fetch failed". Verified by
running the runbook's command verbatim with nothing set: **ISOLATION PROBE PASSED
— all 14 probes denied**; the other two likewise (`3440 role/route pairs`, and
the family probe green after its own fix directly above).
// THE RUNBOOK LISTED ONE OF THE FOUR, with a stale count ("18 roles × 91
routes"). It lists all four now, and states the two things that make their output
readable: they need a running stack and are not in CI, and `POST /auth/login` is
rate-limited 10/min per IP — so **two runs back to back fail on the LIMITER**,
which reads as a broken stack and is not. A probe may also report a role or route
SKIPPED for the same reason; it says how many, and **a skipped role is not a
passed one**.
// The served copy is generated: `pnpm --filter @sms/web build:runbooks` after
editing, the same rule the onboarding manual already carries, and
`runbook-freshness.test.ts` fails if it is not.
// THIS IS WHY THE PROBE ONE ENTRY UP HAD ROTTED. A false positive survives
indefinitely in a tool nothing runs — and the reason nothing ran it starts with
the documented command not working.

### The family-scope probe cried wolf about the one case it never tested
Ran the probe rather than reasoning about scoping, and it reported
**`LEAK their invoice — real 200 vs non-existent 404`**. The API is CORRECT:
`getInvoice` calls `assertCanAccessStudent`, and a parent asking about another
family's real invoice and about a random uuid gets byte-identical
`404 {"message":"Invoice not found"}` — verified directly before touching
anything.
The defect was in the PROBE. `foreignRecords` picked a record with
`for (const m of text.matchAll(/"id":"([0-9a-f-]{36})"/g)) if (!ownIds.has(m[1])) return m[1];`
and used it for BOTH the student list and the invoice list. `ownIds` is a set of
STUDENT ids, so for invoices it asked whether an INVOICE id was a student id —
never true — and "not mine" was VACUOUSLY SATISFIED. It returned whichever
invoice happened to be first, including one of the probing parent's OWN. The
parent then legitimately got 200 where the ghost got 404, and the probe called it
a leak. (The unused `key` parameter was the tell.)
// **A FALSE POSITIVE IS WORSE THAN A MISSED ONE HERE**, and that is why this is
a fix rather than a note: this probe's entire value is that its output is
believed. One cried-wolf finding and the next real one gets waved through.
// AND THE INVOICE CASE WAS NEVER ACTUALLY TESTED. It passed only when the
arbitrary pick happened to belong to somebody else — right by luck, which is the
standing `a-gate-must-not-pass-by-finding-nothing` already records for a walk
that finds no files. An invoice is foreign when its `studentId` is not one of
mine, so it parses the rows and asks that.
// VALIDATED BY MAKING IT FIRE, both ways, on the running stack: with
`assertCanAccessStudent` deleted from `getInvoice` it reports the LEAK and exits
non-zero; with it restored, `PASS`. The same discipline the probe's own header
already describes for its body comparison.
// GOTCHA when running it repeatedly: `POST /auth/login` is rate-limited 10/min
per IP and the probe signs in as several accounts, so two runs back to back fail
with "could not sign in as staff to build the roster — is the stack up and
seeded?", which reads like a broken stack and is not.

### A three-stage chain approving "Leave: Annual" and nothing else
The workflow inbox renders ONE field from a request's payload — `summary`, a
string a SERVICE wrote — and never the raw payload, deliberately: payloads carry
ids and a future type could put anything in there. Sound rule; only ONE of the
nine request-producing services ever wrote one.
`requestLeave` did not. So head teacher -> HR manager -> principal were each
asked to approve a request titled **"Leave: Annual"**, with no dates, no day
count, and no way to tell whether the person had the days. The web renders
`w.summary` and nothing else, and the approvals page fetches nothing further.
**AND NOTHING ELSE CHECKS.** `requestLeave` validates days > 0, the date order,
the attachment and that the type exists — never the balance — and
`applyFinalizedLeave` adds `lr.days` to `usedDays` with no check either. So a
30-day request against a 20-day entitlement is accepted, approved and applied,
and `usedDays` simply passes `entitledDays`. The control IS the human, which
means the human has to be able to see it.
Live, before: `Leave: Annual`. After:
`30 days · 2026-11-02 → 2026-12-11 · 4 of 20 used this year, 34 if approved
— OVER their 20-day entitlement`.
// THE OVER-ENTITLEMENT IS NAMED, not left as two numbers to compare. It is the
one fact that should change a decision, and an approver reading a queue should
not have to do arithmetic to find it. Silent when the school has set no
entitlement, because "OVER their 0-day entitlement" is noise, not a warning.
// NOT TURNED INTO A REFUSAL. Leave beyond entitlement is legitimate — unpaid
leave, compassionate leave, a school that tracks entitlement loosely — and a
three-stage chain of humans is the designed control. What was missing was the
information, not the gate.
**THE TWO FEE RUNS GOT THE SAME TREATMENT**, because they are the other half of
"approving something that moves money". A hostel or transport run posts a charge
onto EVERY boarder's or passenger's invoice, and its approver saw only the scope
and the due date — `Hostel fee run (all in scope) due 2026-11-30`. How many
families and how much are the two facts the decision turns on. Live now:
`Bills 19 boarders, NGN 28,500.00 in total (as at today).` and
`Bills 30 passengers, NGN 24,000.00 in total (as at today).`
// "AS AT TODAY" IS LOAD-BEARING WORDING: the roll can change between raising and
approving, and a figure presented as exact would be believed.
// GOTCHA, and only running it caught this: my first transport preview summed
`routeStop.fareMinor` and reported **"30 passengers, NGN 0.00"**. A route has a
`fareMode`, and on a FLAT route the fare is on the ROUTE with every assignment
carrying a null `stopId` — ZERO of the demo's 30 had one. It also missed
`postFeeRun`'s other two rules (only STUDENT passengers are invoiced, and a
zero fare is skipped). It calls the service's own `fareFor` now: **a preview
that reimplements the rule is a preview that can disagree with the run it is
previewing**, which is worse than no preview at all.
// The remaining producers are named in the gate with what their TITLE carries,
so a reader can judge whether it is still enough — a student exit names the
pupil, an attendance amendment names the date, a content publish names the
content. The generic `/workflows` create route is exempt with a reason: the
CALLER supplies title and payload, so there is no service there to write a
summary, and a money-moving type added to `WORKFLOW_TYPE_META` needs a producer
of its own rather than that route.
Gate: `what-the-approver-is-shown.spec.ts` — every producer either summarises or
is named as title-only, and a money-moving one must actually put `summary` in its
PAYLOAD (a summary computed and not passed is the same blank inbox).
// GOTCHA: the existing `leave.service.spec` stubbed `db` with `runAsTenant`
only, and the balance read is `runAsTenantReadOnly` — a shape the real
`TenantDatabase` always has. Same fixture-modelling trap as the notification and
library stubs: the stub described something the system cannot produce.

### The term lock was checked when the amendment was raised, not when it applied
A register older than `STALE_REGISTER_DAYS` cannot be corrected by a plain
teacher directly: it raises an `ATTENDANCE_AMENDMENT` that a DIFFERENT senior
approves, and a WorkflowHooks reactor applies the marks in-tx.
The term lock — *"a register in a term that has ENDED is read-only for everyone,
including leadership"* — is checked in TWO places: when the amendment is RAISED,
and on the direct-write path. **The reactor called `applyRegister`, the
low-level write, with NEITHER.**
Approval happens LATER and a term roll-over is a nightly job, so an amendment
raised inside the current term can sit pending while that term closes. Approving
it then wrote into a frozen register. The rule as stated here is not "hard to
do", it is **"no edit EVEN WITH APPROVAL"** — and this was the one path where an
approval was the thing doing it. Same shape as the notification queue two entries
up: a guard at the funnel, and the act happening somewhere later.
Live, on a pending amendment for **2026-07-01** (Third Term, ended 2026-07-24)
approved while the current term began 2026-09-07: **409** naming the reason, the
request left `PENDING_REVIEW`, and the register untouched at 785 PRESENT rows
before and after.
// IT MATTERS BECAUSE A CLOSED TERM IS TREATED AS FROZEN EVERYWHERE ELSE. The
report card for it is already printed and filed in the Document Vault, and
`attendance_term_rollup` is already computed — neither follows a register that
moves afterwards, so the correction would have made the child's own documents
disagree with the school's register.
// THROWN, NOT SKIPPED. The hook runs in the SAME transaction as the transition,
so the throw rolls the approval back and the approver is told why. Applying
nothing while recording APPROVED is the silent-success shape this repo keeps
finding — the approver would believe a register had been corrected.
// FAILS OPEN when `currentTermStart` returns null, matching the direct-write
path: unconfigured terms must not make every correction impossible.
// CHECKED AND SOUND in the same pass: a workflow request's PAYLOAD is immutable
once raised — there is no PUT or PATCH on the controller and nothing updates
`payload` — so what a second person approves is what the first person submitted.
// GOTCHA in the test: the reactor is registered IN THE CONSTRUCTOR, so an
`Object.create(prototype)` instance never wires it up — the fixture would have
exercised nothing and passed. It constructs the service for real and captures
the callback from a stubbed `WorkflowHooksService`.
// GOTCHA while probing: a hand-inserted `stages` array of bare strings makes the
engine refuse with **"You are not the undefined approver"**. The stage is an
OBJECT (`{key,label,permission}`); the message reads the missing field. Not worth
a fix on its own, but worth knowing when a workflow probe refuses oddly.

### An archive that named what it held and never what it did not
`SchoolArchiveService` is the artifact a school takes away for its own retention
— the answer to "can we keep our record if we leave". Its manifest declares
`scopedSections`, `snapshotSections`, `truncatedSections` and `sectionCounts`:
four careful statements about what IS in the file, and **nothing about what is
not**. Measured live on the demo tenant: ten sections with counts (students 901,
attendance 173,701, auditLog 24,796 …) and no field naming a single omission.
Not in it: **medical records, emergency contacts, guardian links, Document Vault
entries, discipline records, class-teacher remarks and character ratings.** A
school opening this in ten years cannot tell whether a missing emergency contact
means the child had none or means the archive never carried them — the exact
ambiguity the student export bundle's `coverage` manifest was built to remove,
one level down. That bundle went from "COMPLETE" to 18 sections and 9 excluded
CATEGORIES each with a reason; the ARCHIVE, the bigger artifact, never got the
same treatment.
`excludedSections` now names each with a reason that gives the reader a NEXT
STEP — "ask the school's data controller", "download them from the Document
Vault", "a pupil's own are in their NDPR export bundle" — because "not included"
alone reproduces the ambiguity rather than removing it. Live, read out of the
real 95 MB file: the manifest carries all five.
// **THE MEDICAL ONE IS A DECISION, NOT AN OVERSIGHT, AND IT IS NOT MINE TO
TAKE.** Widening what leaves the building for minors' medical data has Golden
Rule #5 weight; what is taken here is SAYING SO. And adding the section
naively would have been worse than omitting it: `medical_record` is
field-encrypted per tenant, its columns are NOT `Enc`-suffixed, and the
archive's decryption pass keys on exactly that suffix and runs only over
`staff` — so the archive would have carried a child's allergies as unreadable
ciphertext while looking complete.
// CHECKED WHILE THERE, and clean: `SisService` is the ONLY writer of the four
medical columns and always through `encryptField`; and the archive's `invoices`
section DOES include `lineItems` and `payments`, so the financial record is not
half a ledger.
// The four existing statements stay — omissions are an ADDITION, not a
replacement: a reader needs both halves to judge completeness. The gate asserts
that, and that no exclusion names a section the archive in fact carries, which
would send a reader away from data they already have.

### One definition of "paid", and three places that could not express it
`FeesService.paidMinor` has always stated the rule in its own doc comment: **net
paid is POSTED payments MINUS POSTED refunds; PENDING_APPROVAL and REJECTED rows
never count toward the balance.** Fifteen sites hand-write that reduce — and
three used a Prisma `_sum`, which CANNOT subtract a REFUND, so they approximated
it two different ways and **both understate what a family owes**:
```
where: { status: POSTED, kind: PAYMENT }   refunds EXCLUDED    -> short by the refund
where: { status: POSTED }                  refunds POSITIVE    -> short by TWICE it
```
On an invoice of 500 paid 300 and refunded 100 the school is owed 300. The first
shape says 200; the second says 100.
The three, and what each decides:
- **`MobileMoneyService.charge`** had the second shape — no `kind` filter at all,
  so a REFUND was added as a positive. It is the amount the rail ASKS A PARENT
  FOR, and once it clamps to zero the parent is told **"This invoice is already
  settled"** and cannot pay on that rail at all.
- **`StudentExitService`** had the first, on the screen where a transcript is
  RELEASED OR WITHHELD. Live after: a GHS invoice of 5,000,000 paid 3,000,000 and
  refunded 1,000,000 reports **3,000,000** outstanding; `kind: "PAYMENT"` reported
  2,000,000.
- **`LibraryService.settleInvoiceIfPaid`** had the first, and it decides whether
  an invoice is marked PAID.
// THE CARD RAIL WAS ALWAYS RIGHT, which is what made this visible: it does the
reduce properly, and on a live NGN 50,000 invoice paid 30,000 and refunded 10,000
it asked for exactly **NGN 30,000** while the aggregates disagreed. Sibling
asymmetry once more, with the correct one written first — the mobile-money rail
came later and reached for `_sum`, which is the one tool that cannot say it.
// TOO LOW IS THE DANGEROUS DIRECTION. A balance that is too high is an argument
at the bursar's desk; one that is too low is money the school never asks for.
`fees/net-paid.ts` is now the one definition (`netPaidOf` / `netPaidMinor` /
`netPaidByInvoice`), and the batched form exists because a `groupBy` cannot
express the sign — one extra round trip for the correct number is the trade.
// `netPaidOf` deliberately does NOT clamp at zero: a refund larger than the
payments leaves a NEGATIVE net, and hiding that from whoever reconciles it would
be its own defect. The CALLERS clamp the outstanding, which is a different number.
// GOTCHA: nine existing tests broke, all stubbing `payment.aggregate` with a
PRE-SUMMED total — a shape the database never returns for this question. They
model the ROWS now, which is what makes them able to see a refund at all.
// Mutation-validated against all three shipped shapes: refunds positive, refunds
excluded, and the POSTED filter dropped so a pending payment moves a balance.
// **THERE WERE FOUR, AND I FIXED THREE.** `student-exit.service.ts` has TWO
balance reads — the exit PREVIEW and the LEAVERS LIST that feeds the bursar's
chase — and I corrected the preview and left the list, whose own comment already
said *"the same defect as the exit preview above"* about an EARLIER divergence
between exactly those two. That is the whole argument for a gate rather than a
sweep, made against myself.
Gate: `a-balance-a-sum-cannot-express.spec.ts` refuses any `payment.aggregate` /
`payment.groupBy` summing `amountMinor`, with two named exemptions that say why
the sign does not apply to them — `heldByPlatformMinor` (money awaiting a
settlement RELEASE, where a refund to the payer is not a release to the school)
and the maker-checker WINDOW total (a refund does not create headroom under the
threshold, and letting it subtract would reopen that hole).
// GOTCHA, caught by the gate against its own author: my first exemption list
named `operator-payments` and `growth`, which aggregate
`platform_subscription_payment`, `message_credit_entry` and `agent_commission` —
DIFFERENT TABLES, none with a REFUND kind. The gate found two sites where the
list claimed four. An exemption for a rule something was never subject to is
noise that makes the next reader trust the list less.
// Every one of the fifteen HAND-WRITTEN copies was checked and is correct,
including the three raw-SQL ones and both scholarship reads (which filter POSTED
on the reduce rather than in the query, which is why a grep of the `where` looks
alarming and is not). The defect was confined to the shape that cannot say it.

### A renewal erased the fine that had already accrued
The overdue fine is computed ONLY at return, from the loan's CURRENT `dueAt`:
`max(0, floor((now - dueAt) / day)) * perDay`. And `renew` sets
`dueAt = max(dueAt, now) + RENEW_DAYS`. So renewing an overdue loan pushed the
due date into the future and the days already late stopped existing.
**`library.borrow` is held by STUDENT, and `renew` accepts the borrower
themselves** (`loan.borrowerId === p.userId`), so this needed no staff at all —
a pupil clears their own fine by pressing Renew. Measured live, twice on the
same 30-day-overdue loan of the same book:
```
returned without renewing        fine NGN 1,500.00
pupil renews their own, returns  fine NGN     0.00
```
After: **NGN 1,500.00**, with `lateDaysCarried=30` on the row.
`book_loan.lateDaysCarried` (migration `20270112000000`) banks the days already
late IN THE SAME conditional write that moves `dueAt`, and the return charges
`carried + since the new due date`. Days already late are a FACT about a loan,
and a renewal is not a reason for a fact to stop being true.
// DELIBERATELY NOT A REFUSAL TO RENEW WHILE OVERDUE. Whether a school extends an
overdue loan is its own policy, and a librarian granting one to an ill pupil is
legitimate; what must not happen is the charge quietly disappearing when they do.
The renewal still succeeds — only the fine survives it.
// The audit row carries `lateDaysCarried`, because a fine that outlives a
renewal has to be explainable from the trail or it reads as a mistake at the desk.
// GOTCHA, and MUTATION TESTING is the only thing that caught it: the first four
tests all watched the RENEWAL banking the days, and deleting the carried term
from the RETURN's fine calculation left every one of them green. Two halves, and
I had guarded one — the same seam that hid the CBT score and the report-card
promotion line. The return is now driven through the real service too.
// GOTCHA in my own arithmetic: `loan.lateDaysCarried` is `undefined` on a
hand-built stub and `undefined + n` is **NaN**, which would reach a fine and an
invoice. `?? 0` is hygiene there, not a fallback with an opinion — the column is
NOT NULL DEFAULT 0, so it is only ever absent on a stub, and three fixture files
gained it.
// SCALE: on the demo tenant, 26 loans, 1 renewal, and the one renewed loan was
returned with a fine — so nothing needs correcting. This would have gone wrong
the first time a pupil noticed the button.

### The guard was at creation; the bytes leave up to a day later
`NotificationService.persist` drops EXTERNAL channels for a departed recipient
and for a school that is switched off, and its own comment says it checks "once,
HERE, rather than at each of the ~40 producers: a rule that has to be remembered
at every call site is one that will be missed." Right about the producers — and
it is CREATION time, which is not when the bytes leave.
A delivery row sits PENDING until the worker runs, and a STRANDED one is
re-queued by `NotificationRecoveryService` for up to `GIVE_UP_AFTER_HOURS` (24),
swept hourly. **Inside that window the operator can SUSPEND the school, or the
recipient can EXIT, and the row — written when both were fine — was still sent.**
An email in the name of a school its owner had switched off; an SMS spending a
paid message credit on somebody who no longer works there and cannot open the
inbox it lands in. CLAUDE.md states the property as "Nothing reaches a
switched-off school"; the funnel enforced it and the QUEUE went around it.
Re-asked at the wire now, in `runDeliveries` — the one place every send passes,
normal path and recovery alike. Cheap: the recipient row was already being read,
so `status` is one more column, and school status is a 15s-cached lookup.
Live, staging the exact race — write a PENDING email delivery, THEN switch the
school off, then run the shipped worker: `{"sent":0,"failed":1}` and the row
reads **`FAILED — school is not active`**. It records WHY rather than reporting a
quiet zero, the same rule the "no target" and "no credits" arms already follow.
// WRITTEN TO MIRROR `persist` EXACTLY — `recipient && status !== "ACTIVE"`, not
`status === "ACTIVE"`. The difference is a row whose status cannot be read:
persist lets that through, and a guard at the wire that blocked it would refuse
mail the guard at creation had allowed. Two spellings of one rule is how a pair
drifts, which is the whole reason this defect existed.
// FAILS OPEN on an unreadable school status, for the reason `persist` already
gives: an absent dependency must not silently stop every school's mail.
// GOTCHA, and the precedent was already recorded: the check fails CLOSED on a
stubbed `user` row carrying no `status` at all, which broke six existing worker
fixtures and no real path — every `user` row has the column. Same trap
`still-here.ts` documents; same answer, the stubs gained the column.

### Wait for the timer, read the answer, post it back
Found by driving a path that had never executed: `live_quiz_session`,
`live_quiz_participant` and `live_quiz_answer` all had zero rows, so the Live
Quiz — the largest of the five untested game services — had never once been
played end to end.
The core is SOUND and was verified rather than assumed: mid-question a pupil's
own payload carries `answerIndex: null` while the host's carries `1`; the answer
key behind `GET /quizzes/:id` is gated on `game.quiz.host`, which no pupil holds
(checked against the seeded role map); a second answer to the same question is a
409; and scoring is server-side off `questionStartedAt`.
**WHAT WAS NOT SOUND WAS THE BOUNDARY BETWEEN TWO RULES.** `buildSessionView`
REVEALS `answerIndex` to players once a question's clock runs out — deliberate,
so the class sees what the answer was — and `answer` had NO CLOCK CHECK AT ALL.
The two boundaries were computed in different places and only one of them
existed, so the gap between them was an exploit needing no tooling: wait for the
timer, `GET /quiz-sessions/:id` and read the answer out of your OWN payload,
post it back.
// **THE ENGINE ZEROING THE POINTS IS WHY THIS LOOKED HARMLESS.**
`scoreQuizAnswer` returns `{points: 0, newStreak: 0}` once `elapsedMs >= limitMs`,
so the exploit earned nothing — and the service went on writing `correct: true`
beside it and incrementing `participant.correct`, which is a PUBLIC LEADERBOARD
COLUMN shown by display name to the whole class. Measured live: a pupil who
genuinely answered ONE of two questions was listed as
`{"displayName":"Demo Student","score":798,"correct":2,"rank":1}`. After:
**409 "The clock ran out on that question"**, and the row reads `correct: 1`.
// ONE `clockOf`, read by BOTH — the reveal and the refusal are now the same
instant by construction. They were two computations of one fact, which is the
shape this repo keeps finding; here only one of the two was ever written.
// NO GRACE WINDOW, deliberately, and the reasoning is the point: any latency
grace on the SUBMISSION side would have to be a grace on the REVEAL side too, or
it reopens the window it exists to close. A pupil whose click arrives late
already scored zero before this change, so refusing costs them nothing they were
getting — it only stops a tally that was never true.
// The refusal is also the truer message: `{"correct":true,"points":0}` reads to
a pupil as a scoring bug, and "the clock ran out" reads as what happened.

### The operator directory named the admin who had left
Found by sweeping for services with NO TEST FILE AT ALL — ten of them, and this
is the one that reads cross-tenant PII. `contactsIn` supplies the name, email and
phone the PLATFORM OWNER rings: to chase an overdue subscription, answer an
onboarding question, warn about a chargeback. It had NO status filter and took
the EARLIEST-appointed holder.
A staff exit deliberately KEEPS the `user_role` row — it is employment history,
and auth refuses the login instead — so the directory went on naming whoever was
appointed first whether or not they still work there. Measured live: a school
whose founding admin had left and whose current admin was appointed afterwards
was listed as **`admin=Demo Admin`, the departed one**, with the active one not
shown at all. After: `admin=Current Admin`, the other schools unchanged.
An EXITED user cannot authenticate, so the owner would also have been emailing an
inbox its owner can no longer open — and been told it was delivered. Same shape
as the assignment sweep, on the platform's own console.
// NOBODY ACTIVE IS REPORTED AS NULL, never a fallback to a leaver. Verified live
by exiting both: the row reads `admin=—`. A school with no reachable admin is a
fact the operator needs; a name that cannot be reached is worse than a blank,
because it gets dialled.
// Same rule as `holdersOf` ("an approver is somebody who is still here") and
`assertStillHere` ("work is only ever given to somebody who is still here"),
reusing the same `STILL_HERE` constant rather than a fourth hand-rolled filter.
`schoolProfile` shares the read, so the drill-down was fixed with it.
// CHECKED AND SOUND in the same pass, so neither is re-litigated:
`role-permissions.service.ts` — the authorization spine, also untested — resolves
role→permissions from the DB with the `@sms/types` map as its outage fallback,
and the two agree exactly: **19 roles compared, 0 diverged**, so a DB outage
changes nobody's authority. And the clickwrap chain is complete: a fresh public
onboarding request stores `legalVersion: 1.0` as evidence at submit, and the
school's own acceptance is taken in-app by `LegalAcceptBanner`. The unused
`"ONBOARDING"` context on `legal_acceptance` is a dead enum value, deliberately
left: carrying the APPLICANT's acceptance forward as the SCHOOL's would weaken
the evidence, since they need not be the same person.

### A letter dated a day early, and a duty withdrawn for a lesson already taught
An earlier sweep moved "today" onto the SCHOOL's calendar day across the
register, the gate scan, the term lock and the rest, and recorded that the
remaining `toISOString()` uses "label a document; they do not key a record".
That is the right test for a CSV filename and the wrong one for two of them.
**THE LETTER DATE IS THE CONTENT, NOT A LABEL.** `LetterService` prints `Date:`
on an official letter that says *"They remain in our employment AS AT THE DATE OF
THIS LETTER"* — handed to banks, embassies and other schools — and computed it as
`new Date().toISOString().slice(0, 10)`. In UTC a letter issued at 07:00 in
Singapore is dated YESTERDAY and one issued at 21:00 in Toronto is dated
TOMORROW. Measured live on the running stack: with the school on `Asia/Singapore`
the letter now prints **2026-08-27 while the server's UTC day is 2026-08-26**;
with the timezone unset (the platform's home) it prints the same date it always
did, so nothing moves for anyone already live.
**AND ONE OF THE "SIX" WAS NOT LABELLING ANYTHING AT ALL.**
`TimetableService.deleteEntry` FILTERED which relievers get told their duty was
withdrawn — `date >= new Date(new Date().toISOString().slice(0, 10))` — while
every other cover read resolves the school's timezone. East of UTC that day is
YESTERDAY, so deleting a lesson told a teacher that a lesson they had ALREADY
TAUGHT was cancelled: precisely the noise its own comment says the rule exists to
prevent, "on the one channel that has to stay worth reading". Classified as a
harmless label by a sweep that counted it among the six; it never was one.
// THE RULE MOVED TO WHERE THE NOTICE LIVES. `LessonCoverService
.coversAheadInTx` is now the one definition of "ahead", beside
`announceCoverWithdrawn` — the two withdrawal paths already shared one notice and
did NOT share one calendar, which is exactly how they drifted.
// GOTCHA: the existing spec stubbed the cover service, so moving the call made
five tests fail with "coversAheadInTx is not a function" — the suite doing its
job. Its `asks only about cover still AHEAD` case asserted on a query
`deleteEntry` no longer makes, so the fixture now binds the REAL method with a
stubbed region and the case asserts WHICH day: stubbing it away would have left
the property asserted against nothing.
// GOTCHA in my own test, not the code: the letter body is JUSTIFIED, so pdfkit
positions each word separately and the extracted content stream carries
`AdaOkonkwo` with no space. Compare with whitespace stripped.
// LEFT ALONE, deliberately: the other five are genuine labels — a CSV filename,
"printed"/"generated" footers — and `exam.service.ts` prints its stamp with an
explicit "UTC" suffix, which is honest rather than wrong. Full ISO timestamps
(`exportedAt`, `producedAt`, `cutoff`) are INSTANTS and correct as UTC.

### The cap bounding what a parent pays was a naira figure, in every currency
`platform_fee_config` was a SINGLETON keyed `id='fees'` carrying `flatMinor` and
`capMinor` in minor units with NO currency at all — its own validation messages
saying "(kobo)". The take-rate rides the Paystack split, and Paystack settles
NGN, GHS, ZAR, KES and USD, so the same kobo figures were applied to all of them.
Measured against the LIVE row (150bp capped at 200,000):
```
NGN 150,000 invoice -> parent pays NGN 2,000    the cap binds, as intended
GHS   5,000 invoice -> parent pays GHS    75    "cap" is GHS 2,000 — never binds
KES  75,000 invoice -> parent pays KES 1,125    "cap" is KES 2,000 — never binds
ZAR  15,000 invoice -> parent pays ZAR   225    "cap" is ZAR 2,000 — never binds
```
**The cap is the ONLY thing bounding a convenience fee, and the fee is borne by
the PARENT by default.** In every non-naira currency it sits 12x to 100x above
the intended ceiling, so it is effectively disabled and the full 150bp is charged
uncapped. `flatMinor` is worse if ever set: a ₦100 flat becomes GH₵100 a
transaction. Fourth instance of "A NAIRA CONSTANT IS NOT A RULE FOR EVERY SCHOOL".
Keyed `(id, currency)` now (migration `20270111000000`), exactly like `plan_price`
and `module_addon_price`. The existing row backfills as NGN, so every live
Nigerian school is charged precisely what it was.
// **THE FAIL-SAFE POINTS AT ZERO, AND THAT IS THE WHOLE POINT.** A currency with
no row charges NOTHING — which is what this service's own header already promised
for a MISSING ROW ("fail-safe: no school is charged until the operator opts in"),
applied one level too shallow. The rule this repo already states: an unset CONTROL
tightens, an unset CHARGE goes to zero, because a charge that guesses bills a
family. Converting instead would need an FX rate this platform does not have.
// THE LEVER STILL EARNS: `GET/PUT /operator/platform-fees?currency=` and a
currency selector on the operator card, so the owner states the ceiling in the
school's own money. Live: setting GHS to 150bp/GH₵20 took a GH₵5,000 invoice from
**GH₵75.00 uncapped to GH₵20.00**, with NGN untouched at ₦2,000.
// All three consumers now name the currency they are CHARGING IN — invoice
checkout (the invoice's own currency), the settlement-posture card and the
ADMISSION FORM FEE, which resolved the school's currency four lines BELOW the
fee it had already computed in naira.
// GOTCHA found by driving the operator PUT rather than reading it: `update()`
ended `return this.effective()` with no argument, so saving a cedi rate echoed
the NAIRA row back — `PUT {currency:"GHS",capMinor:2000}` answered `capMinor
200000`, which reads to an operator as a save that did not take. The GET beside
it was already right. The audit row now carries the currency too: "set to 150bp
capped at 2,000" says nothing about which market once there is more than one.
// The operator card was naira-only in three separate ways — `/100`, `en-NG`,
and a "Flat (₦)" label — while editing the one config applied to every currency.
It scales by `minorUnits(currency)` now, so a zero-decimal currency is not 100x
wrong, and the preview is in the currency being priced.
// GOTCHA: `?currency=` goes through a `narrowCurrency` narrower beside
`narrowStatus`, because answering an unrecognised currency with the naira config
is the defect itself in a new place. Live: `?currency=XOF` -> 400 naming the set.

### A naira figure, quoted in dollars, on the add-on price list
Asked to review the public -> onboarding -> payment flow for easy onboarding and
revenue generation. Driving it end to end as a prospect (public submission ->
operator queue -> provision -> invite -> billing -> checkout) found the funnel
itself SOUND, and one defect on the price list.
Tier prices have been per-currency since dual-currency billing shipped:
`PLAN_PRICING_BY_CURRENCY` in code, `plan_price` keyed `(plan, currency)` in the
database, and `PlanPricingService.effective()` REFUSES a currency it has no
prices for — its own comment saying why: *"quoting a tier at zero, **or silently
at the naira price**, is worse than saying the market is not open yet."*
**THE ADD-ON TABLE BESIDE IT WAS ONE BARE NUMBER FOR EVERY MARKET**, every
comment above it denominated in naira (`₦225/seat`, `₦45 each`, `an add-on at
₦80`) — and `AddonPricingService.resolve()` did not merely omit USD, it wrote it
out explicitly and handed it the kobo table:
```
[CURRENCIES.NGN]: { ...MODULE_ADDON_PRICING },
[CURRENCIES.USD]: { ...MODULE_ADDON_PRICING },   // the SAME figures
```
`module_addon_price` is keyed `(module, currency)` and has NO ROWS, so that seed
is what every school actually got. Measured live on a provisioned school: a USD
school was quoted HOSTEL at **12,500 cents — $125 per seat per month against a
$0.65 ULTIMATE tier**, about 192x the tier that contains it. Per seat: $56,250 a
month for one module at 450 pupils. Nobody buys that, so the add-on lever — a
built revenue mechanism with a shop, proration and renewal billing behind it —
was simply DEAD in USD, silently. Third instance of the class this file already
records under "A NAIRA CONSTANT IS NOT A RULE FOR EVERY SCHOOL".
Live after, same school: **$125.00 -> $0.06** per seat per month; the naira
school reads ₦80/₦125 exactly as before.
// **THE GATE COULD NOT SEE IT, AND THAT IS THE REAL LESSON.**
`add-ons-never-undercut-the-upgrade` proves two invariants — an add-on costs more
than its share of the tier, and by the third the upgrade wins — and BOTH ONLY
CATCH A PRICE THAT IS TOO LOW. A naira figure in a USD tier is absurdly HIGH, so
it satisfies both trivially: pointing USD at the kobo table left the suite GREEN.
Found by mutation-testing the fix rather than by reading. The missing invariant
is now there — **one module never costs more than the WHOLE tier that contains
it** — and every invariant runs for every shipped currency, since a ladder proven
in one currency is not a ladder.
// `effective()` now REFUSES an unpriced currency instead of falling back, the
rule its sibling already followed; `list()`'s `?? 0` is gone too, because
quoting a module FREE is the one answer that costs money.
// THE USD FIGURES ARE A STRUCTURAL DEFAULT, the same standing `PLAN_PRICING_USD`
has — chosen to satisfy both invariants against the USD tier table, and an
operator `module_addon_price` row overrides them per currency. Worth the owner
confirming as prices; they are correct as a ladder.
// GOTCHA: a test on the pure table proves nothing about the RESOLVER that seeds
it, and the seed was where this lived — so the spec drives the real
`AddonPricingService` with no operator rows, and is mutation-validated by
restoring the exact shipped line.
// CHECKED AND SOUND, so it is not re-litigated: provisioning stamps only
`country` + `calendarTemplate` and leaves timezone/locale/currency NULL — correct,
because `resolveRegion` falls back to `countryProfile(school.country)`, so a
Ghanaian school resolves to GHS rather than to the platform's naira. The trial
stamps `currentPeriodEnd = now + 30d` so dunning can eventually fire; the
onboarding request auto-APPROVES on provision; and the email chain is complete —
acknowledgement to the applicant, alert to the owner, "is now live" to the
ORIGINAL contact and a welcome + 7-day set-password invite to the new admin, with
a temp password as the fallback. A brand-new school with no pupils quotes at a
floor of ONE seat, so a per-seat plan can never check out at zero.

### A birth certificate the school erased, still ticked off as held
The right-to-erasure fix that reached supplied documents was recorded here as
LATENT — `document_submission` had no rows, so it had never run. Driving the
whole path for the first time (define requirement -> signed upload -> confirm ->
verify -> erasure -> read back) proved it works: `erasedSuppliedDocuments: 2`,
storage keys and original names cleared, bytes gone from disk. That half is now
VERIFIED rather than asserted.
**WHAT IT NEVER TOLD WAS THE CONSUMING SIDE.** The row kept `status: UPLOADED`,
and `SATISFYING_STATUSES` treats that as "the school has it". Measured live: after
a school erased a child's birth certificate at the family's request, its own
paperwork screen went on reporting `birth_certificate` as **SATISFIED** — while
clicking the row answered **404 "This submission has no file"**. Two surfaces
disagreeing about one fact, and because the requirement never returned to
`outstanding`, nobody would ever be asked for it again: the other four were
chased and that one was not.
// THE OUTLIER WAS THE CHECKLIST, and two siblings had already got it right —
the download refuses with a stated reason, and `promote` guards
`if (!s.storageKey) continue` before carrying a document onto a pupil's
permanent record. Both anticipated a row whose bytes are gone; the screen that
counts the paperwork did not.
`ERASED` is now its own status and is deliberately NOT in `SATISFYING_STATUSES`.
// IT MUST NOT READ AS "THE FAMILY NEVER SENT IT" — REJECTED means the school
looked and refused, PENDING means the upload never finished, and neither
describes a file the school held and gave up. Hence a distinct value the screen
labels "Erased at request" rather than folding it into an existing one; whether
to ask for the document a second time is the school's decision to take, not
something the product should imply by putting it back on a chase list unmarked.
The dead "Open" link is gone with it.
Live, the whole cycle: outstanding 5 -> **4** once supplied and verified ->
**back to 5** after erasure, status `ERASED`, opening it 404. Before, it stayed
at 4 with a 404 behind it.
// GOTCHA: the pure helpers passed with the SERVICE never writing the status —
the seam this repo keeps recording. The existing `an-erasure-that-left-the-birth-
certificate` spec drives the real service and asserts the exact `data` object,
so it went red on the change and is where the status is pinned. Mutation-
validated both halves (drop the write; put `ERASED` into the satisfying set).
// Also checked while there, and clean: cross-tenant reads AND writes on a
submission are 404 and byte-identical to a random uuid; the file is reachable
only by a holder of `student.profile.write`, so a teacher, another family and
the pupil themselves all get 403.
// NOT FIXED, and recorded rather than quietly left: `confirm`, `decide` and
`waive` all call `toSubmissionDto(row, new Map(), new Map())`, so
`requirementLabel` and `verifiedByName` are ALWAYS null on those three
responses — `decide` is the very action that SETS the verifier and cannot name
them. Latent only because `DocumentChecklist` calls `router.refresh()` and
ignores the body; a caller that rendered the response would show a blank label.

### One invisible character, and the SMS bill doubles
An SMS is billed by the SEGMENT: GSM-7 holds 160 characters (153 once
concatenated), and a message carrying ONE character outside that alphabet is
re-encoded as UCS-2, which holds 70 (67). The school is debited **one message
credit per MESSAGE** and the platform pays Twilio **per SEGMENT** — so a single
character is the difference between charging once for one segment and charging
once for two. Measured against this repo's own templates filled with realistic
values: **13 extra segments across 28 templates**, and EVERY fee notification —
the commonest kind, and the ones about money — came out at two.
The cause per currency, and it is not the obvious one:
```
NGN  "₦25,000.00"       ₦ U+20A6   <- the platform's HOME currency
GHS  "GH₵25,000.00"     ₵ U+20B5
KES  "Ksh 25,000.00"    U+00A0     <- an INVISIBLE no-break space
ZAR  "R 25 000,00"      U+00A0
XOF  "2 500 000 F CFA"  U+202F, U+00A0
USD / GBP                          (fine — $ and £ are in GSM-7)
```
Five of seven, and the two that are fine are the two this platform is least sold
in. The KES/ZAR/XOF cases are the sharpest: the character is a SPACE that looks
exactly like a space, is indistinguishable on any screen, and doubles the bill.
**`formatMoneyPdf` already existed for precisely this problem in a different
output** — a target that cannot carry the symbol, so it prints the ISO code.
SMS is a third target with the same constraint and had nothing. Sibling
asymmetry again, with the correct one written first.
`toSmsSafe` (`@sms/types/sms-text.ts`) at the TWILIO CHANNEL BOUNDARY, not at
the producers — the same placement as the pdfkit fold, and for the same reason.
TWO PASSES AND THE ORDER MATTERS: invisible separators and typographic
punctuation are normalised ALWAYS (imperceptible, so there is no reason to pay
for them); a currency symbol is swapped for its ISO code ONLY IF the message is
still not GSM-7 after that — a visible change, made only when it buys something.
// **IT NEVER MANGLES A NAME TO SAVE MONEY.** A pupil called `Ṣadé` is sent as
`Ṣadé`, in UCS-2, at whatever it costs — and since that message is UCS-2 either
way, `₦` is left as the nicer form. Folding a child's name into a cheaper
alphabet is a different act from swapping a symbol for the code it stands for,
and only one of them is legitimate.
// GOTCHA: `GH₵` naively becomes `GHGHS `, and a doubled prefix reads as a typo.
Live through the SHIPPED provider, intercepted at the wire: NGN fee notice
**UCS-2/2 segments -> GSM-7/1**, KES **UCS-2/2 -> GSM-7/1**, and the Yoruba-named
one unchanged at UCS-2/2 with the name and the ₦ intact.
**AND THE COST IS NOW RECORDED.** `num_segments` was dropped by the adapter —
exactly as the SID once was, and the listing dropped it too, so the question
"what did the platform pay for what it charged once?" could not be asked from
our own data. `ChannelDeliveryResult.segments` carries it, the send logs
encoding + segments, and `CreditReconcileResult.billedSegments` reports it
against `providerSent`. Undefined when the provider does not say — undefined is
not zero, and reporting zero reads as "cost nothing".
// DEBITING N CREDITS PER N SEGMENTS IS DELIBERATELY NOT DONE: that changes what
a credit MEANS to a school that has already bought bundles, which is the owner's
pricing decision, not a correctness fix. The exposure is measured and surfaced
so the decision can be taken on a number.
Gate/tests: `a-character-that-doubles-the-bill.spec.ts`, mutation-validated two
ways (stop normalising the spaces; always apply the symbol swap).
// GOTCHA in my own test, not the code: 80 `€` is EXACTLY 160 septets and 81 is
two segments — the extension table costs two septets each. I asserted 2 for 80
and the implementation was right.
// GOTCHA I INTRODUCED AND CAUGHT BY TESTING A CONSEQUENCE OF MY OWN CHANGE:
WhatsApp rides the SAME Twilio Messages API and went through the same fold. It
is a different product — billed per CONVERSATION, not per segment, and it
renders Unicode natively — so folding `₦` to `NGN ` there degraded what a family
reads and saved nothing. GSM-7 is a constraint of the SMS WIRE, not of Twilio,
and a shared transport is not a shared billing model. SMS only now, and a
WhatsApp send reports `segments: undefined` rather than inventing a 1.

### A child whose name the report card could not print
Found by RUNNING a path with a name this market actually uses. Renaming a pupil
to `Ṣadé Adéọlá Ọbi` and asking for their report card returned **HTTP 500,
"Invalid character in header content"** — Node refuses a byte outside Latin-1 in
a header value, and `Content-Disposition` is built from the pupil's own name. So
a child with an ordinary Yoruba or Igbo name **could not have a report card
generated at all**, in the platform's home market.
**THE DOCUMENT BODY FAILED DIFFERENTLY, AND WORSE.** pdfkit's built-in fonts are
WinAnsi — single-byte — and handed a codepoint outside it pdfkit writes that
codepoint's BYTES into a single-byte string, so the character does not go
missing: it becomes DIFFERENT LETTERS. Measured against this app's own pdfkit
(0.19.1): `Ṣadé Adéọlá Ọbi` emitted
`<1e62 61 64 e9 20 4164 e9 1ecd 6c e1 20 1ecc 6269>` — `Ṣ` (U+1E62) became
0x1e + 0x62 (`b`), `ọ` (U+1ECD) became 0x1e + 0xcd (`Í`). The card would print
roughly `badé AdéÍlá Íbi`. Nothing errored, so nothing would ever have reported
it — on a document that is printed, filed in the Document Vault and emailed to
guardians.
FOLD, DO NOT DROP: `Ṣadé` deleted is `ad`; folded to the base letter it is
`Sadé` — the child's name imperfectly rather than somebody else's name
confidently. Accents Latin-1 CAN carry (`é`, `ü`, `ñ`) are kept exactly as
typed, so a French or Spanish name is untouched; `中文名` folds to nothing and
the filename falls back to `download` rather than emitting `filename=""`.
The fold lives at the **pdfkit boundary** (`common/pdf-document.ts`,
`createPdfDocument`), not at the places a name is written — twelve generators
and hundreds of `doc.text` calls between them, and a rule applied per call site
is a rule the next generator is written without. `widthOfString`/`heightOfString`
are wrapped too: they are how text is centred, and measuring the UNFOLDED string
lays the page out for characters the page does not contain.
// GOTCHA, and a test caught me getting it wrong: **WinAnsi is NOT Latin-1.**
CP1252 fills the 0x80–0x9f range Latin-1 leaves as controls with the typographic
characters — en and em dash, curly quotes, ellipsis, bullet. So a PDF can print
`A 70–100 excellent` and a HEADER cannot. One shared fold replaced the en dash
right across the grade key on every report card; `foldToLatin1` (header) and
`foldForPdf` (WinAnsi) are two functions for two targets. Verified live by the
BYTE: the grade key carries 0x96, the CP1252 en dash.
// GOTCHA: the sweep fixed 22 header sites by hand and MISSED the one that runs
in cloud production — `s3-storage.provider.ts` was a FOURTH hand-rolled copy of
the rule, stripping control characters and no non-Latin-1 character, feeding a
filename AWS then signs into the URL. The gate found it, not the sweep. Same
shape this repo already records for the CSV formula guard that existed 9× under
4 names.
// THE REAL FIX IS AN EMBEDDED UNICODE FONT and is deliberately not done: the
image has no system fonts at all, so it means shipping a TTF and registering it
in all twelve generators. Until then a name is folded, and this is the record of
what folding costs.
Live, before and after, same pupil: **500 "Invalid character in header content"**
-> **201**, `filename="report-card-sadé-adéolá-obi.pdf"`, and the card printing
`Student: Sadé Adéolá Obi`.
Gate: `a-download-name-survives-its-header.spec.ts` — every interpolated
`Content-Disposition` filename is folded, and no PDF is built outside the
factory. Mutation-validated three ways (unfold one header, restore one bare
`new PDFDocument`, break the fold itself), each caught by the assertion written
for it.
// GOTCHA: `a-broken-bar-where-the-naira-should-be` anchored on the literal
`new PDFDocument(` and went red over the change that MOVED the fold to the
boundary — a change that strengthened the property it guards. Re-anchored to the
factory. The fixed-text failure mode, again, and again firing on an improvement.

### A review queue that could only see the page it had just decided
`subject_selection.list` / `MeetingRequestService.list` and four siblings. The
shape is one this repo has already recorded twice — for the chargeback banner
and the admissions queue — and it had four more instances, plus a fifth worse
than any of them.
**The screen asked the database for a capped page and then asked ITSELF what
was waiting**: `rows.filter(s => s.status === "PENDING_…")` over a `take: 200`.
Two properties combine badly. A row is PENDING precisely because nobody has
dealt with it, so pending rows AGE — and a newest-first cap drops the OLDEST
first. So the rows the filter exists to surface are exactly the rows it cannot
see, and the card renders a confident **"Nothing awaiting review."**
**SUBJECT SELECTIONS WERE THE WORST OF THE SIX, for two reasons.** They are
bounded by the COHORT, not by the school's lifetime — one term of a 901-pupil
school is 901 rows — so the cap is passed in the FIRST TERM, not in year five.
And the list was ordered by `updatedAt`, **which a REVIEW bumps**: every
decision pushed the un-reviewed rows further out of sight, so the harder an
admin worked the blinder the queue became. Measured live on exactly that
fixture: 21 selections awaiting approval, 200 rows returned, **every one
APPROVED**, panel reading "Nothing awaiting review." And only APPROVED
selections feed the grading roster, so those 21 pupils were off it too. After:
`items=21 total=21 pendingTotal=21`, oldest first.
**MEETING REQUESTS HAD THE TOOL AND NEVER USED IT.** `list(p, { open })`
narrowed to the waiting statuses IN SQL, `?open=1` was documented on the route
— and its ONE caller, the meetings page, fetched the unfiltered 200 and split
it in memory. Somebody built the right thing and the screen next to it did not
call it.
Both now take `?filter=open|decided` and return a page carrying `pendingTotal`,
**counted in SQL over the caller's whole scope and never narrowed by the filter
or the page** — the rule the disputes banner already states: a count a filter
can change is a count a filter can hide. `filter=open` is ordered OLDEST FIRST,
because a review queue is worked from the front and the longest wait is the one
that matters; everything else stays newest-first, which is what a history wants.
The other four — promotion batches, the student and parent import batches, and
the operator's own onboarding funnel — keep their in-memory split and are made
CORRECT instead: the service returns every open row (oldest first) and then the
recent history, so the split can no longer be lying. That is the cheaper fix and
it is the right one where the open set is small; what makes it safe is that the
gate holds both halves together.
Gate: `a-queue-that-only-sees-the-recent-page.spec.ts`. The web half refuses a
`.filter(... status === "PENDING…")` unless the component is EXEMPTED, and each
exemption names the service that guarantees it is handed every open row; the
API half asserts that guarantee. Neither half stands alone, which is the point.
// GOTCHA: the API half first anchored to the FILE and passed with promotion's
narrowing deleted — these files mention a status and a `PENDING` somewhere
else. Anchored to the LIST METHOD's own body now. A gate looking one scope too
WIDE fails exactly like one looking one scope too narrow, and only mutation
testing tells them apart; validated three ways, one per shape of the fix.
// GOTCHA: `SelectionReview` is a client component, so the count is fetched in
the browser and never appears in the SSR HTML — the trap already recorded under
`verifying a client component`. The evidence is the API response, not a grep of
the page.


### The window a caller typed, the window the query used
`dateFilter` / `dateWindow` / `boundedInt` (`apps/api/src/common/status-filter.ts`)
finish the job `narrowStatus` and `pageNumber` started: a `?status=` was made to
refuse a value it could not read, and the DATES and NUMBERS beside it were still
guessing. One input class, failing in both directions at once.
**Answered 500 to a typo** (`new Date("abc")` -> Invalid Date -> Prisma):
`/analytics/overview`, `/attendance/by-class`, `/exams`, `/library/report`,
`/security/audit` and `/hr/leave/calendar` — the last invisible to the first
probe because it ran as a principal, who does not hold `hr.leave.manage`. **A
permission is not a validator**, and a route nobody can reach with the wrong
credentials is not a route nobody can reach. `?limit=abc` and `?days=abc` did the
same through `Math.min(Math.max(Number(x) ?? D, 1), MAX)`, which looks like it
clamps and does not: `??` never fires for NaN, so the default is unreachable and
`take: NaN` reaches the database.
**Answered 200 with the wrong figure**, which is worse. `/operator/payments` —
the platform owner's revenue ledger — tested `/^\d{4}-\d{2}-\d{2}$/` itself
and SILENTLY DROPPED anything else, so `?from=2026-08-01T00:00:00Z` (not a typo:
the shape `toISOString()` produces, which is what any script or export sends)
returned the ALL-TIME total under an August caption. Measured live: **17
payments and NGN 25,700,236.64 for a window holding 15 and NGN 20,698,312.50**.
That file's own header says these filters live in the URL precisely so a finance
query can be "bookmarked, shared with an accountant" — which makes a hand-held
URL a first-class input, not an edge case. `/alumni?year=abc` dropped the year
the same way, and `hr/attendance/summary` reported the CURRENT month under the
year asked for — via a comment saying the service "treats NaN as not given",
written while fixing a 500 on a call with NO parameters. **That fix closed one
hole and opened a quieter one.**
**THREE SIBLINGS ALREADY REFUSED, and each said something different** — "Invalid
window", "Invalid date range", "from/to must be YYYY-MM-DD". Correct three
times, in three wordings, which is the shape that precedes a fourth being
written with no check at all; the journal CSV stated the rule twice for one
export, once in the controller and again in the service. All now say one thing,
and it names both accepted shapes.
// GOTCHA: a date-only **body** field is deliberately NOT widened. A date of
birth, a due date, a last working day are DAYS, and `@db.Date is a DAY, not an
instant` is already a rule here. Only the 12 list FILTERS take a window.
// GOTCHA: `dateWindow` also refuses a BACKWARDS window. `from` after `to`
matches nothing and renders as "no payments in that period" — true of the query
and false of the world, the same confident-false-statement the whole file is
about.
// GOTCHA in the gate: `new Date(from.getTime() + N)` is a legitimate use of an
already-parsed Date, and flagging it hides the real offender underneath while
teaching the next person to exempt it. Bounded with a negative lookahead;
mutation-validated three ways.
// GOTCHA in a TEST, not the code: `a-leave-record-that-fell-off-the-end`
asserted `w.startDate.lte` equalled a specific millisecond. Both leave columns
are `@db.Date`, so snapping a date-only `to` to end-of-day selects exactly the
same rows — the test pinned an implementation detail and went red over a change
that alters nothing it exists to protect. It asserts the property now.


### A page number nobody validated turned a typo into an incident
`narrowStatus` / `pageNumber` (`apps/api/src/common/status-filter.ts`) are the ONE
place a query-string filter becomes a value the database sees. Every paged list
parsed its own: `page: q.page ? Number(q.page) : undefined`. `Number("abc")` is
`NaN` and `Number("1e999")` is `Infinity` — neither is falsy, so both sailed past
the guard, reached Prisma as `skip: NaN`, and came back **HTTP 500 "Internal
server error"** with a stack trace and a Sentry event. Measured live before:
`/students/exited`, `/operator/tenants`, `/operator/payments`,
`/operator/payments/export.csv`, `/notifications`, `/operator/directory` and the
message-credit ledger all 500 on `?page=abc`. After: **400 naming the range**, on
all seven, with the unparameterised call unchanged.
A 500 is the wrong answer TWICE. It tells the caller nothing they can act on —
the fix is "1", and the message says "Internal server error" — and it spends an
alert: a 5xx is what pages somebody, so a mistyped URL in a bookmark bar is
indistinguishable from the database being down. The same reasoning already
governs `narrowStatus`: an unrecognised `status` is refused with the allowed
values NAMED, never silently ignored, because a filter that quietly matches
everything reports a number the user believes is filtered.
// GOTCHA: **the gate passed while `/operator/payments` was still 500-ing.** It
scanned each route handler's BODY, and that route's parse lives in a private
`paymentFilters(q)` helper further down the file — the handler body had nothing
to flag. A gate looking in the wrong place is the failure
`a-gate-must-not-pass-by-finding-nothing` names, one directory over. It scans
whole controller FILES now, mutation-validated by restoring the helper's
`Number(q.page)` and watching it go red.
// GOTCHA: `pageNumber(page)` CONTAINS the substring `Number(page)`, so the
obvious pattern flagged every site the fix had just corrected. The lookbehind is
what makes it a call to `Number` rather than the tail of another identifier —
the same trap as the comment-stripping one three gates over, where a gate went
red on a comment EXPLAINING the defect it exists for.

### A refusal must not confirm what it hides
"Errors never leak cross-tenant existence — return 404, not 403" is a stated
convention here and 97 refusals follow it. Three did not, and TWO WERE IN ONE
FILE, forty lines above a sibling that got it right and carried a comment saying
why — someone fixed one of three, wrote the reason down, and left the others.
// GOTCHA: **two things were wrong and only one of them was the status.**
`ForbiddenException("Invoice not found")` is self-contradicting — the 403
confirms the record exists while the text denies it. But the branch beside it
said "Not your invoice", ALSO a 403, so the MESSAGE separated an id that exists
in the school from one that does not. Making both 403 would never have been
enough: the pair must be indistinguishable in status AND in wording, or the check
is a probe. Live, a parent asking about another family's real invoice and about a
random uuid now gets byte-identical `404 {"message":"Invoice not found"}`.
Gate: `a-refusal-must-not-confirm-what-it-hides.spec.ts` refuses a 403 whose
message says "not found", and any refusal beginning "not your" — a message naming
a record's OWNER tells the caller the record is real.

### A gate that walks must say it scanned something
This repo leans hard on gates that walk the source tree, derive a set of
offenders and assert it is EMPTY. They share one silent failure: **a walk that
finds no files produces no offenders and passes with a green tick while covering
nothing** — a moved directory, a changed extension, a renamed root.
Demonstrated rather than argued: pointing `csv-injection`'s walk at a directory
with no `.ts` files left every assertion green, so the spreadsheet-formula guard
could have been deleted from every export in the product without that gate
noticing. It had already happened twice for real, in different disguises —
`platform-org-not-a-school`'s 200-character window silently covering 2 routes
instead of 3, and `every-mutation-leaves-a-trail` resolving methods by NAME so
`this.db.runAsTenant(...)` matched a `runAsTenant` that happened to audit (green
for the wrong reason: deleting the audit call it existed for did not fail it).
Sixteen gates walked without a magnitude assertion; all sixteen now have one.
`a-gate-must-not-pass-by-finding-nothing.spec.ts` enforces the rule on every
future gate, and holds itself to it — validated by writing a new blind gate and
watching it go red, and by re-running the csv-injection experiment, which now
fails as it should.

### The dashboard headcount counted children who had left
Swept every aggregate with no `where` — 73 of them. Most are reference data
bounded by a school's STRUCTURE (subjects, periods, rooms, classes, terms) and
never grow. One was not.
`AnalyticsService` counted pupils with `enrollment.groupBy({ by: ["studentId"] })`
and took `.length` — directly beneath a comment reading "COUNT in the database —
never findMany().length (ships whole ID sets)". It returns ONE ROW PER DISTINCT
PUPIL to produce one integer, over a scan of every enrolment row the school has
ever written (pupils x years).
**And it counted the wrong people.** `student-scope.ts` is explicit that a
dashboard headcount wants ON ROLL; an enrolment-derived count is EVER ENROLLED.
Live proof: exit 50 pupils and the figure should fall — before it stayed at 901,
after it reads 851. Now one indexed `user.count({ where: ON_ROLL_STUDENT })`.
// GOTCHA: the sweep that fixed twelve such sites watched for a hand-rolled
`role: { name: "student" }` and could not see this one, because it reached the
same wrong answer BY A DIFFERENT ROUTE — through enrolment. A gate that watches
one road to a wrong answer will eventually meet the other. `student-scope.spec.ts`
now refuses a distinct-pupil count derived from enrolment too, with the archive
named as the one legitimate EVER-ENROLLED exception.

### The bank list counted every question the school had ever written
`listBanks` drew its counts with `groupBy({ by: ["bankId"], _count: { id: true } })`
and NO `where` — so every page load aggregated the school's entire question
table whatever was on screen, and nothing archives a bank. O(how long the school
has been teaching), not O(what is shown).
Measured as the APPLICATION role with RLS in force, 200 banks / 80,000 questions
(a busy secondary school's decade): **103.3 ms / 1,380 buffers -> 3.6 ms / 59
buffers**, Seq Scan + HashAggregate becoming an Index Only Scan on
`(schoolId, bankId)`.
// GOTCHA: TWO changes and both are needed. Scoping to the listed banks is what
lets the index be used at all; `_count: true` counts ROWS rather than the `id`
COLUMN, and THAT is what makes it index-only — counting a column must visit the
heap for every row to read it. Scoped count(id) was 9.3 ms; scoped count(*) is
3.6 ms.
// WHERE THE CEILING IS, stated rather than implied: the list is deliberately NOT
paginated because it feeds the bank PICKER, and paging a dropdown is a worse
product than the problem it solves. At 800 banks / 320,000 questions — a bank
every four days for a decade, past any real school — it costs 48 ms against 114
before. Still O(the school's banks), so it degrades eventually; it would take
thousands of banks to be felt.

### A question bank outlives the teacher who wrote it
Asked directly: a subject teacher builds CBT banks over years and resigns — does
the school still have them? **Yes, and structurally rather than by luck: bank
visibility is decided by the READER's role, never by the bank's author.**
`listBanks` returns `{}` (every bank) to anyone school-wide or holding
`cbt.review`; `getBankQuestions` shows the questions to the same people;
`canTouchBank` returns true for school-wide roles BEFORE it looks at authorship.
principal and school_admin hold both `cbt.manage` and `cbt.review`. Nothing on
the read path joins the author's `user` row, so `status = EXITED` cannot hide a
bank — and there is no FK from `createdById` to `user` at all, so even a hard
delete could not cascade one away. **And the next teacher of the subject inherits
it with no administrative act**, which is why a bank must name its subject.
Verified live: bank authored by `teacher@demo.school`, that user set to EXITED,
principal / school_admin / head_teacher each still list it and open its
questions (HTTP 200).
Pinned by `a-question-bank-outlives-its-author.spec.ts`, because a later tidy-up
would break it without meaning to — adding `assertStillHere` to a read path, or
joining the author to show a name, would each quietly remove a school's own exam
material. Mutation-validated both ways.
// GOTCHA: what WAS missing is that nobody was told. `StaffHandoverService` listed
eleven duties and not the banks, so a school kept the material and had no idea it
existed. Banks are now a twelfth entry — the only ASSET on a list of obligations,
labelled "still readable by leadership" so the notice cannot be misread as a
warning that access is at risk.

### A leaver's duties are named, never silently reassigned
`StaffHandoverService` (`GET /hr/staff/:userId/handover`, `hr.read`; panel on
`/hr/staff/[userId]`) lists what a member of staff still holds across ELEVEN
surfaces — class teacher, subject teacher, timetabled lessons, cover,
invigilation, tasks, discipline cases, meeting slots, hostels, vehicles and
appraisals they are reviewing. Approving an exit closed the employment record,
recovered loans and ended access on the last working day, and said NOTHING about
the work; the offboarding checklist's "Handover notes" is a tickbox, the same
shape "Revoke system access" had when it did nothing. Live, one teacher holds 30
class-subject assignments — when they go, 30 pairings name somebody who cannot
sign in and the first symptom is a lesson nobody turns up to.
DATED duties (cover, invigilation, future meeting slots) sort FIRST whatever
their count and are counted separately in the notice: 30 class assignments are a
tidying job, one exam next week is a hall with nobody in it. Only work still
AHEAD counts for those, measured from the SCHOOL's today.
**It reassigns nothing, and says so** — the platform cannot know who should take
a class, and moving 30 assignments to a name it picked is a worse failure than
the silence. Signals for a human decision (Golden Rule #8's posture, applied to
HR). The notice goes to the approver AT APPROVAL, not on the last working day:
approval is when there is still a notice period in which to hand over. Nothing
is sent when they hold nothing — a notice that fires on every exit is one people
learn to ignore, including on the exit where it mattered.

### The family-scope probe derives its own surface, and compares BODIES
`pnpm --filter @sms/web probe:family` signs in as a real parent and a real pupil
and looks for another family's child. It used to probe THIRTEEN hand-written
paths while a pupil's session could reach 133 GET routes — so it now reads the
API's controllers, keeps the routes whose `@RequirePermission` the account
actually holds, and probes those (60 for a parent, ~70 for a pupil, plus every
route taking a `:studentId`, asked about somebody else's child). A hand-kept list
of "what a family can reach" is a list that falls behind, the same reason the RLS
coverage meta-test computes its set from `pg_class`. Parameterised routes it
cannot fill are COUNTED OUT LOUD rather than skipped silently.
// GOTCHA, found by deleting a real control to check the probe could see it:
**comparing STATUS is not enough.** With `assertCanRead` removed,
`/reportcards/:studentId/remarks` returned 200 carrying another family's child —
and a non-existent id ALSO returned 200 with an empty body, so the statuses
agreed and the probe said "ok". It now compares the two BODIES with the
requested id stripped out (an endpoint that merely echoes the id back differs
without disclosing anything). Re-validated both ways: control removed + the
probed child given a remark ⇒ FAIL naming the route; control restored ⇒ PASS.
Both halves are validated by making them fire — the listing half against a
teacher, who legitimately sees 480 pupils.

### An anonymous vote is only anonymous if the LOG agrees
`apps/api/src/observability/anonymity.ts` lists the routes whose whole point is
that nobody can tell who called them — `POST /polls/:id/vote` and
`POST /forms/:id/respond` — and pino's `customProps` plus the Sentry interceptor
withhold `user_id` on them (everything else — method, route, status, latency,
tenant, request id — is still logged, plus `user_withheld: "anonymous route"` so
the absence is legible).
The poll module had done everything right: schema says "Identity is never
revealed", the vote's audit row is written under SYSTEM *because* "naming the
voter there handed leadership the roll of who answered a poll about leadership",
no read returns voterId beside optionId, results are tallies. The REQUEST LOG,
added later by the observability spine, undid all of it. Measured live, one vote:
`log POST /polls/…/vote user_id c337f8f4… 09:59:03.648` against
`poll_vote "Option A" 09:59:03.635` — **thirteen milliseconds apart**, so log +
database recovers not just WHO voted but WHAT THEY CHOSE, for everybody.
A ROUTE, not a flag: a form is anonymous only when it says so and the logger
cannot know that without a read on the request path, so every form response
withholds it — costs operations nothing, and getting it wrong the other way
breaks a promise made to a child. Patterns are anchored at BOTH ends and the
query string is stripped before matching (a `?` would defeat the anchor).
Over-withholding is not free — every id withheld is an incident somebody cannot
trace — so reads, creates and closes are deliberately NOT on the list.

### Sentry gets the exception, and nothing from the request
`Sentry.init` ran on defaults. `requestDataIntegration` defaults to
`{ cookies: true, data: true, headers: true, query_string: true }` — and `data`
is THE REQUEST BODY. Run against this app's own SDK (8.55.2) with a transport
that never leaves the process, one captured exception carried
`{allergies:"penicillin", conditions:"asthma", medication:"salbutamol inhaler"}`,
the `Authorization` bearer token AND the session cookie: a child's medical record
sent to a third party, for data this platform field-encrypts at rest with a
per-tenant key and audit-logs every read of. A 500 on `POST /auth/login` would
have sent the plaintext password the same way. pino had already been hardened for
exactly this (it redacts authorization/cookie/x-stepup/webhook signatures and
strips the query string) — two recorders of the same requests, one careful and
one not.
`observability/sentry-options.ts` now owns the options main.ts passes, so the
test exercises THE SAME object rather than a copy. Nothing request-derived
survives: no body, headers, cookies or query string. What a 5xx is debugged from
— the exception and its stack, plus the request id, method, matched route, status
and tenant that `ErrorLoggingInterceptor` attaches explicitly — is untouched.
BELT AND BRACES on purpose: the integration option is version-specific (its
defaults are internal and have changed before) and `beforeSend` is the published
contract that runs last on every event. // GOTCHA: deleting `query_string` is not
enough — the same secret lives INSIDE `request.url`, so `…/medical?token=secret`
survived until the url's query was stripped too (the test found that, not a
reading of the SDK). // GOTCHA: the redundancy is asserted STRUCTURALLY, because
behaviour cannot see it — `beforeSend` scrubs everything, so removing the
integration option changes no output and every behavioural test still passes.

### A duty that is given with a notice is taken away with one
Assigning work notified the person; withdrawing it notified nobody, in three
modules at once: `removeInvigilator`, `deleteSitting` (which cascades EVERY seat
and invigilator), `removeCover`, `deleteEntry` (whose `lesson_cover` FK is
ON DELETE CASCADE) and the duty roster's `remove` were all silent. Discipline and
meetings already did it right, which is what made the rest visible; class-teacher
assignment is silent BOTH ways and is deliberately left alone — symmetric silence
about something you read off a page is not a stale duty you turn up for. So the only record a teacher held still told
them to be in Hall A for an exam that no longer exists, or to teach a lesson that
is no longer theirs. A teacher who turns up has wasted a free period; one who
does NOT turn up, assuming it was withdrawn, is a class left unattended — the
thing cover exists to prevent.
They NOTIFY rather than refuse: deleting is legitimate (timetables change, exams
are cancelled) and the defect was the silence. The cascade path and the explicit
removal share ONE notice (`LessonCoverService.announceCoverWithdrawn`), so a
reliever is told the same thing whichever way the duty vanished, and only work
still AHEAD is announced. `deleteSitting` now also records `seatsDeleted` /
`invigilatorsRemoved` — "it cascades" is a fact about the database, not an answer
to "where did those thirty seats go". // GOTCHA: the roster must be read BEFORE
the delete; afterwards the cascade has taken it and there is nobody left to tell.

### A clash check that reads and then writes is not a clash check
`lockPerson` (`apps/api/src/common/person-lock.ts`) takes a transaction-scoped
advisory lock on `(schoolId, personId)` before the invigilator and cover
double-booking checks. Both READ what somebody is down for, decide the overlap in
Node, then INSERT — with nothing in between. Proved live, one member of staff and
two sittings in the same 09:00–11:00 window:
`sequential 201 then 409` (the check works) versus `concurrent 201 and 201` —
rostered in TWO halls at nine o'clock, which is exactly what the check exists to
prevent. After: 201 and 409, either order, one hall.
A LOCK, NOT A CONSTRAINT: the other races here were closed with a unique key or
an atomic claim (library decrements `availableCopies` with a predicate, hostel
row-locks the room), which works when the thing claimed is ONE ROW. A clash is
"does any row overlap this window" — two tables for cover, an interval comparison
for exams — and no unique index expresses it. Same tool `TermResultService`
already uses for the shared result row. Keyed per PERSON (seating a hall is a
burst of these, so a per-school lock would serialise the lot) and per SCHOOL (the
advisory namespace is cluster-wide, so without the tenant one school's rostering
blocks another's). `_xact_` so nothing is left held by a request that threw.
The SAME race in a shape an index CAN express is closed with a partial unique
index instead (migration `20261229000000`): "one active X per person" was
code-only on four paths — `hostel_allocation`, `transport_assignment`,
`staff_exit`, `employment_change_request` — meaning a boarder in two beds, a
passenger on two routes, and two settlements or two pay changes awaiting approval
for one person. Prefer the INDEX wherever the rule is expressible as one: it is
declarative, binds every writer for ever including a manual fix at 2am, and costs
nothing at read time; the lock is for rules an index cannot state. The code guards
STAY — they produce the sentence a user reads — and each site wraps its write in
`asDuplicate(message, …)` so the loser of a race is told the same thing as
somebody who simply pressed second, not a 500. // GOTCHA: that translator must
NOT key off `meta.target` — Prisma does not populate it here (the same trap
`TimetableService` documents), and a fixture that supplies one makes the tests
pass against code that cannot work. The translation must also mirror the guard's
own STATUS (`asDuplicate` = 400, `asDuplicateConflict` = 409) — two named helpers
rather than a parameter, because a guard that says 409 and a race that says 400
are distinguishable, which makes the race observable to the user.
The sweep found 21 such guards; the database already backed 15. Of the six it did
not, one was a false positive (a "not found" guard) and `ultimate_entry_link` was
already unique — the remaining six are closed by `20261229000000` and
`20261230000000` (adding one sitting per CBT exam, and one open meeting request
per parent+child+teacher).

### One school's failure must not end the fleet's sweep
Of the scheduled cross-tenant jobs, the late-fee sweep, the attendance rollup and
the message-credit reconciliation already caught, counted and carried on per
school. **Retention and billing dunning did not**: the first school to throw
abandoned every school after it — and for retention the PLATFORM-WIDE streams
below the loop too (gateway events, read notifications, old job runs). It would
fail the same way every night, so the damage is not one missed night but an
indefinite one: minors' telemetry retained past the window a school told parents
about, and lapsed subscriptions never chased or told. Both now catch per item,
NAME the school in the log (a count says four failed and never which; the one
failing nightly is the one worth fixing) and COUNT the failure into the returned
result — `DunningResult.failed`, `RetentionResult.failed` — because the job-runs
catalogue is what an operator reads and "12 scanned, 3 reminded" while four
schools threw reads as a quiet night. Live: `{"scanned":2,"failed":0,…}`.
// GOTCHA: catching per school is exactly what stops the sweep THROWING, so
`lastOk` stays true, `overdue`/`overrunning` are false, and the operator's jobs
console counted a run that skipped four schools as healthy — its health test was
`neverRun || overdue || lastOk === false || overrunning`. `JobStatusDto.lastFailed`
now carries the job's own `failed` out of the stored summary (opt-in: a job with
no such notion reports null, which is not zero), the console marks the row
"Partial" and says how many were left as they were. A count nobody surfaces is a
count nobody acts on.
// GOTCHA when verifying a client component from SSR HTML: `JobsTable` is
`"use client"`, so the server sends the DATA and the browser renders the badge —
grepping the page for "Partial" matches the shipped bundle, not a rendered row.
Assert the prop (`lastFailed` in the payload) or drive a real browser.

### Every text control can be named by a screen reader
`apps/web/lib/__tests__/every-control-has-a-name.test.ts` fails if any `<input>`,
`<select>` or `<textarea>` has no accessible name — 99 controls were unnamed
(26 inputs, 68 selects, 5 textareas). CLAUDE.md already committed to accessibility for the
integrity module — paste-blocking "MUST have an exemption flag per student… or it
becomes discriminatory" — and that reasoning had never been applied to the rest of
the UI: 26 inputs announced as "edit text, blank", among them the FILE INPUTS a
parent uses to send in a child's documents, the date filters on the attendance
register and the exam planner, and the meeting-slot times. All 99 now carry an `aria-label`
taken from the surrounding UI: a select's own placeholder option where it had one
("Room…" → "Room"), otherwise the value binding, humanised. // GOTCHA: that
derivation was ~75% right and confidently WRONG for the rest — "Select", "+ role",
"No classes", "Present", "— none —" — all read off an option that was never a
label. Each was corrected by hand, because a wrong name asserted to a screen
reader is worse than none. The shadcn primitives (`ui/textarea.tsx`,
`ui/input.tsx`) are EXEMPT: they forward props, and hard-coding a name there would
put the same wrong label on every control in the app.
What counts as a name: `aria-label`, `aria-labelledby`, an `id` (assumed paired
with a label's `htmlFor`), or being wrapped in a `<label>`. A PLACEHOLDER is
accepted but reported, never treated as a label — it vanishes the moment somebody
types; 26 inputs currently lean on one.
// GOTCHA, and why the gate PARSES instead of grepping: `<input[^>]*>` truncates
a JSX tag at the first `>`, and `onChange={(e) => …}` supplies one. My first scan
therefore reported inputs that were already labelled — I "fixed" one carrying
`aria-label={isCode ? "2FA code" : "Password"}` further down its own tag, and only
the TypeScript duplicate-attribute error caught it. The gate reads each tag to its
matching `>` at brace depth zero, and strips COMMENTS first (a JSDoc block
documenting `<input type="datetime-local">` is not a control anyone can fix).

### A theory mark that was awarded, recorded, and then not shown
Found by RUNNING a path that had never executed: `cbt_theory_answer` had zero
rows, so the whole theory-question flow — author, sit, answer, mark, record —
had never once been exercised. Driving it end to end on the live stack found a
defect no test or sweep would have.
`cbt_sitting.score` holds a script's OBJECTIVE part only. That is deliberate: it
is written when the candidate submits, and theory is marked later by a human;
`provisional` says "not final yet", and `markingProgress` states the rule —
while any theory answer is unmarked the stored score "is only its objective part
and **must not be presented as final**". The moment marking FINISHED,
`provisional` went false and that same objective-only number WAS presented as
final. Measured live on a 1-objective + one 10-mark-theory paper, marked 8/10:
the candidate scored **9 of 11 and was shown 1 of 11**, on their own results
screen and on the staff results table.
**The record was right and every human-facing number was wrong**, which is the
worst shape for this: `recordGrades` computed `objective + theoryMarks` itself
and filed 49.09/60 (9/11 scaled to the school's exam component), so nothing
downstream was corrupt and nothing would ever have surfaced the contradiction.
Only the two READ paths disagreed with the grade in the child's own record.
The results table was the sharper half. It orders by score once marking
completes, and its own comment explains why it deliberately does NOT before: "a
ranking built on half-marked scripts actively inverts — the candidates strongest
on theory sit at the bottom". Ranking on the objective part AFTER marking
produces precisely that inversion, having gone to the trouble of avoiding it
during. It now sorts in Node on the true score, because the theory marks live in
another table and SQL cannot order by them.
One named `scriptScore(objective, theoryMarks)` is now the single definition,
called by the candidate view, the results table AND `recordGrades` — the path
that was always right — so a fourth reader finds it rather than inventing a
fourth answer. // GOTCHA: the candidate view ALREADY read the theory rows,
`marksAwarded` included, to compute `provisional` — the marks were in hand and
simply not added. // GOTCHA: a test on the helper proves nothing about the
views; both display paths are exercised through the real service and
mutation-validated separately, the same seam as the audit-partition processor.
Partial marks ARE counted while provisional — `provisional` is what says the
figure is not final, and showing a lower number would be less true, not safer.
// The answer key does NOT leak: the candidate's payload carries
`answerIndex: null` with `answersReleased: false`, and `markGuide` is absent
entirely. Checked, because `"answerIndex" in q` looked alarming and was the
wrong test.
// GOTCHA the fix exposed, and another instance of the fixed-window class:
`lms-apply-only-participants` asserted "CBT writes only for candidates who SAT"
by slicing from the FIRST `const sittings = await tx.cbtSitting.findMany` to the
FIRST `const rows = sittings.map`. That window spanned TWO METHODS and caught
`recordExamGrades`' status filter only because `examResults`, which comes first
in the file, happened not to declare a `rows` const of its own. Giving it one
closed the window early and the test went red while the property it guards was
untouched. Now anchored to the method by name — and mutation-validated, which
the accidental version never was.

### A filter nobody validated answers a question nobody asked
`/fees/disputes` was fixed for this once and the reasoning was written down: "an
invalid `status` is a 400 that renders the LOAD-FAILURE card — never 'No disputes
recorded', which is a statement about money a finance officer acts on". SIX
siblings kept the old behaviour, one of them three hundred lines below that fix
in the same controller. An unrecognised value failed in one of two ways, and
both are worse than an error:
```
passed into the query   -> matches NOTHING    -> "no boarders are signed out"
dropped to undefined    -> matches EVERYTHING -> the whole ledger, "filtered"
```
Measured live, each before and after: `/invoices?status=OVERDUE` — the obvious
guess — returned **all 14 invoices** under that label; `/library/loans?status=OUT`
turned **26 loans into 0**; `/hostels/exeats` turned **one overdue boarder into
none**, which is a safety statement about a child made by a typo; and
`/operator/feedback`, `/operator/directory` (three filters in one object) and
`/hostels/incidents` all answered as though unfiltered or empty.
ONE helper, `narrowStatus` (`common/status-filter.ts`), not six hand-rolled
checks — this repo already records what the alternative costs ("the CSV formula
guard existed 9× under 4 names"), and a control written six times will be right
five times. It refuses with the ALLOWED VALUES NAMED (`status must be one of
ISSUED, RETURNED`), because "invalid status" sends somebody to read the source.
// AN EMPTY STRING IS NOT AN ERROR. A cleared dropdown submits one, and refusing
it would turn a validation fix into a broken "show me everything" — the way this
kind of fix usually goes wrong. Absent, empty and whitespace all mean no filter;
everything else must be exact.
// TWO DELIBERATE EXEMPTIONS, kept in the author's own words rather than
overruled: `/cbt/exams/all` ("this is a filter, not a command, and an empty list
is the honest answer" — staff-only exam admin, not a claim about a child or
money) and `/classes/:classId/content`, whose status can only NARROW within what
the caller may already see.
Gate: `a-filter-nobody-validated.spec.ts` finds every GET taking `@Query("status")`
and requires it to go through the shared narrower or be exempted with a reason.

### Told it does not exist, on the screen that is showing it
Found by RUNNING a path that had never executed: `subject_selection` had zero
rows, so the pick → supervisor → admin chain had never been driven.
`list` shows every selection to a school-wide role OR to a holder of
`subject.selection.approve`. `review` refused anyone without that permission
with a **404**. A PRINCIPAL is school-wide and deliberately does NOT hold it —
the final approval belongs to a school administrator or head teacher — so the
most senior person in the school saw a pending queue ON THEIR OWN SCREEN,
pressed Approve, and was told the selection does not exist. Live: `list` 200
with the row, `review` 404.
**404-not-403 is the right rule, and this is its other edge.** It exists so a
refusal cannot CONFIRM what it hides; it must equally not DENY what the product
has already shown, which reads as a broken screen rather than as a boundary and
sends somebody to support instead of to the right colleague. One predicate,
`seesEverySelection`, now decides both — SHARED with `list` so the two cannot
drift again, which is exactly how they drifted.
// AND THE TERMINAL BRANCH LEAKED. `else throw new ConflictException("This
selection is already " + status)` ran with NO visibility check at all, behind a
route gated on `class.read` — which every teacher holds. Live before this: a
teacher whose own list returned ZERO rows put the id in and got
`409 This selection is already APPROVED`, about a pupil in a class that is
nothing to do with them. A terminal status is still information.
// After, all three measured live: principal → 403 naming who may approve;
teacher → 404, byte-identical to a selection that does not exist; school admin →
201.

### The only report cards carrying a promotion line were the ones with bad news
Found by RUNNING a path that had never executed: `promotion_batch` had zero
rows. Staged a real end-of-session batch for 30 pupils, one RETAINed, and the
maker-checker worked exactly as written — the maker's own approval was refused,
a different admin's landed, 29 enrolments moved to the target class and the
retained pupil stayed ACTIVE in the source. Then the report cards.
**The report card is where a family learns the outcome** — the platform sends no
notification for a promotion, deliberately, because the card is the artefact
designed to carry it. The lookup filtered on `sourceClassId: enrolment.classId`,
and `enrolment` is the pupil's ACTIVE one. Approval marks the source enrolment
PROMOTED and opens a new ACTIVE one in the TARGET class — so for a pupil who was
promoted the source class no longer matched and the line never printed. A pupil
who was RETAINED never moves, so theirs did. Measured live: the retained pupil's
card read `TO REPEAT THE CLASS` and all 29 promoted cards said **nothing at
all**. A DEMOTE moves the pupil too, so it was silent for the same reason.
Now found by MEMBERSHIP of the batch — still narrowed to the TERM and to
APPROVED, so a staged or rejected batch prints nothing and another term's
decision cannot leak onto the card. Live after: `PROMOTED TO VOL JSS2 A` on both
promoted pupils, `TO REPEAT THE CLASS` still on the retained one.
// A TEST PINNED THE OPPOSITE BELIEF, and its reasoning was exactly backwards:
"a promotion batch is a decision taken about the class the pupil is in now;
keying it on a HISTORICAL class would silently drop the line". Keying it on the
CURRENT class is what dropped it. `promotion_batch` had zero rows when that was
written, so nothing had ever contradicted it — a plausible-sounding belief
pinned by an assertion, which is worse than no test because it defends the bug.
Replaced with the corrected property, and the behavioural cases now run against
a REAL DATABASE in `reportcard.service.e2e-spec.ts` (promoted / retained /
demoted / staged-not-approved / not-in-the-batch), mutation-validated by putting
`sourceClassId` back.
// The PDF suite already covered `promotionLine` — it renders whatever it is
handed. The defect was in COMPUTING it. A test on the view proves nothing about
the lookup, the same seam as the CBT score.
### A registry note that named a file which never existed
Same pass, smaller: `api-surface.registry.json` DECLARES how each route is
reached, because runtime-built paths cannot be detected — sound, and it makes
every note an unverified claim. 163 of them name a source file, so that half IS
checkable. One named `components/careers/CareersApply.tsx` for the PUBLIC job
application; the form lives in `components/public/CareersBoard.tsx` and the
named file has never existed.
Worth more than tidiness: a stale note is how a dead route hides — the gradebook
grade write was recorded as "reached from GradingConsole.tsx" while another
controller shadowed it on the same URL. Gate added; mutation-validated.
// GOTCHA: the corrected note first EXPLAINED the fix by naming the dead file,
and the gate flagged its own explanation — the trap
`money-is-not-divided-by-a-hundred` strips comments for. A note says where a
route IS reached from; a filename that no longer exists does not belong in it.

### Two handlers, one URL, and the second one is dead
`GradebookController` and `LmsContentController` BOTH declare `@Controller()`
with no prefix, and both declared `POST submissions/:id/grade`. Nest maps both —
the startup log shows the pair, one line apart — and Express answers with the
FIRST, which is the LMS one. So `GradebookController.grade`, the platform's
assessment-grade write, was **unreachable dead code**.
The two take different BODIES and different PERMISSIONS, so the loser's callers
do not get a diagnosable 404. They get somebody else's error. Measured live: a
teacher holding `grade.write` posted the gradebook's own documented body and got
`400 {"fieldErrors":{"grade":["Required"]}}` — an error about a field they never
sent — and a principal without `content.write` got a bare 403 for a permission
the endpoint they meant does not require. `grade.status` (DRAFT | PUBLISHED)
could not be set through the API at all, which is why every one of the 16,200
grades in the dev database is PUBLISHED: they are written by other paths.
The LMS route MOVED, to `content/submissions/:id/grade` — that controller
already namespaces everything else under `content/`, so the collision was this
one route being the odd one out in its own file; it has exactly one caller, and
the gradebook pair share a path with a GET that does not collide. After: the
gradebook write answers 201 and reads back, and the LMS route still resolves
(403 on the permission gate, not 404).
// A PARAMETER'S NAME IS NOT PART OF THE URL. `:submissionId` and `:id` are the
same route, and that is exactly why this was invisible to a reader — the two
lines do not look alike.
// GOTCHA, and my own first gate had it: `apiRoutes()` keys on the path AS
WRITTEN, so the two were different strings and the gate PASSED with the defect
still in place. Caught only by putting the collision back. It normalises through
`normalisePath` now, and compares across FILES — one file legitimately declaring
several methods on one path is not the shadowing case.
// The surface registry claimed this route was "reached from GradingConsole.tsx".
That file has never called it — the console posts `term-results`. So the record
of how each route is reached asserted a screen that does not exist, for a route
that could not work; a third instance of the class already recorded for the
audit gate's fictional exemption.
Gate: `no-two-routes-answer-the-same-url.spec.ts`, with an EMPTY allow-list on
purpose — a second handler on one URL is not something to permit with a note, it
is a handler that never runs.

### A hall, a date, a class — and no family ever heard of it
Found by RUNNING a path that had never executed: `exam_sitting`, `exam_seat` and
`exam_invigilator` all had zero rows, so the exam hall had never once been used
end to end.
`GET /exams/mine` — what a pupil and a parent read — returns **SEATS**. So an
unseated sitting is invisible to everyone it is for. And seating existed ONLY
per schedule (`POST /exams/schedules/:id/seat`) while the planner's own form
offers **"No schedule" as its first and default option**. So the ordinary way to
add one exam produced a sitting with a hall, a date, a time and a class that
NOTHING in the product could seat and no family could see — while the staff
planner listed it as complete, with an invigilator rostered against it.
Live before: sitting created without a schedule, `POST /exams/:id/seat` → 404,
`/exams/mine` empty for both the pupil and their parent. After: `{"seated":true,
"seatedStudents":1}` and both read "Mathematics Paper 1 seat 1"; a replay says
"This sitting is already seated."
`autoSeatSchedule` now takes `{ scheduleId } | { id }` — one seater, so the two
paths cannot drift on capacity, ordering or idempotency — and `seatSitting`
reports the OUTCOME rather than a fixed success, naming why nothing happened in
the words of the thing to fix ("no class attached", "nobody enrolled", "already
seated"). Idempotent, because a pupil told seat 14 must not later find
themselves in seat 31.
// THE BADGE WAS THE OTHER HALF. The planner already said "not seated" — in a
neutral outline, beside "no invigilator" — which a school reads as tidying-up
rather than as "nobody has been told". It now names the consequence ("not seated
— no student can see this exam") and the row carries the one-click fix; a
sitting with no class says THAT instead, since there is nothing to seat from.
// The pattern is the one this repo keeps meeting from the other side: the staff
surface looks finished, the family surface is silent, and nothing connects them.
Same shape as the report-card zeros directly above.

### Four zeros on a report card, for a term that had not started
Found by RUNNING a path that had never executed: `report_card_remark` and
`student_trait_rating` both had zero rows, so nothing had ever printed a card
carrying either. Driving it end to end — record 20 trait ratings, write both
remarks, generate the PDF, extract the text — showed the traits and remarks are
RIGHT (grouped as the catalogue groups them, scale spelled out, each remark
attributed by name). The attendance block was not.
```
if (d.daysOpened > 0) doc.text(`Times school opened: ${d.daysOpened}`)   // hidden at 0
doc.text(`Present: 0  Late: 0  Absent: 0  Excused: 0`)                   // ALWAYS printed
if (total)            doc.text(`Attendance rate: …%`)                    // hidden at 0
```
The two figures that give the zeros their meaning are suppressed in exactly the
case where the zeros mislead, and the FOUR BARE ZEROS are left standing alone.
The code's own comment six lines above states the principle it then breaks:
"'Times school opened' is the denominator a parent reads the attendance against
— without it 'present: 46' says nothing." **Four zeros are a statement about the
CHILD; no register is a statement about the SCHOOL**, and a parent reads the
first. Live on a real pupil: a term running 2026-09-07 to 2026-12-18, card
generated 2026-08-25 — before the term had begun — printed
`Present: 0 Late: 0 Absent: 0 Excused: 0` and nothing else.
Three states now, all three verified live: no register at all → "No attendance
has been recorded for this term."; register taken and this pupil in none of it →
"Times school opened: 5 … No attendance was recorded for this student, though
the register was taken on 5 days" (a different fact, and one the school can act
on); any record at all → the counts and the rate exactly as before.
// The wording deliberately does NOT say the school failed to open.
`daysOpened` is also zero before a term begins and when no class could be
resolved for the pupil, so asserting anything about the school would be
inventing a fact to replace a missing one.
// SIBLING CHECK, and the PDF was the outlier: `getStudentSummary` already
returns `percent: null` at zero and says why in a comment ("would read as
'never attended'"), and the /attendance page hides the whole card behind
`summary.total > 0`. The one surface that got it wrong is the one that LEAVES
THE BUILDING — printed, filed in the vault, and emailed to guardians.
// The suite that caught nothing here is the one that reads the PDF back
(`reportcard-pdf.spec.ts`); every other report-card test checks the numbers
going IN. Its own header already says why that gap exists.

### One school's currency stopped metering the whole fleet
Found immediately after making seat arrears visible, by asking what happens when
the accrual FAILS. The dunning sweep's per-school guard — added after the
retention sweep taught the lesson — was applied to the dunning loop and NOT to
the seat-arrears accrual sitting directly above it, which stayed inside one
try/catch around the whole fleet.
So the first school that threw abandoned every school after it; the failure was
a single `warn` naming nobody; and `DunningResult.failed`, which the operator's
jobs console reads to decide its "Partial" badge, knew nothing about it at all.
REACHABLE, and proved on the stack rather than argued: a school sold in a
currency `CURRENCIES` supports but which has no `plan_price` rows makes
`PlanPricingService.effective` REFUSE — deliberately, because quoting a tier at
zero is worse than saying the market is not open. Two schools, one of them GHS:
**both accrued nothing** and the sweep returned `{"failed":0}`. Every night, for
the whole fleet, on the one number that records revenue earned and not yet
billed. After: `{"failed":1,"arrearsFailed":1}`, the naira school metered
normally, the log naming `school=7994fa41… No plan pricing for GHS`, and the
jobs console reading `lastFailed: 1` where it read 0.
// `failed` counts SCHOOLS, not incidents — a `Set`, because one school can now
fail both halves and must be reported once. `arrearsFailed` breaks out the
accrual half, because the two are not the same event: a school whose dunning
threw was NOT flipped and NOT reminded, while one whose accrual threw was
handled correctly and merely went unmetered. Reporting them as one number sends
an operator to the wrong place.
// The failed school's `arrearsAccruedAt` is deliberately NOT advanced, so the
next sweep meters its whole window rather than losing it — the failure costs a
night's visibility, never the money.
// A fleet-wide seat-query failure still aborts the accrual, which is right, but
now returns EVERY school as failed rather than warning once: that is what
actually happened.
// GOTCHA: `one-school-must-not-end-the-sweep` asserted the literal source
`failed += 1` and went red on a change that made the count STRONGER — the
fixed-text failure mode this repo keeps recording, this time firing on an
improvement. Re-anchored to the property (schools counted once, accrual
included).

### Earned, unbilled, and on no screen
Asked to verify that a lapsed school falls to the STANDARD floor and is
reinstated on payment, and to trace how the owner recovers the money when a
school pays for 400 seats and enrols 500 more a week later. **Both mechanisms
work**; what was missing was any way to SEE the second one's money.
**THE LAPSE CYCLE IS CORRECT** — driven end to end on the stack:
paid ENTERPRISE 27 modules `/hr` 200 → period lapses, the nightly sweep flips
PAST_DUE and grace KEEPS the tier (`/hr` still 200) → past grace, effective
STANDARD, 10 modules, `/hr` 404 and `/fees` 200 → paid again, ACTIVE ENTERPRISE,
`/hr` 200. Two properties make it safe and both are now pinned: the PURCHASED
plan is never overwritten, so paying restores the tier with no repair step and
nothing to re-resolve; and the reinstatement quote is priced at the CURRENT roll
(901 seats), not the 400 it lapsed on. // The floor deliberately keeps FEES —
cutting a delinquent school off from collecting money is how it stays
delinquent, and fees is where the take-rate is earned. // `effectivePlan`
returns the full tier for an ACTIVE subscription WHATEVER the period says, so
the sweep is load-bearing: expiry is not self-executing, which is why that job
counting and reporting its failures matters.
**THE SEAT METER IS CORRECT TOO.** 400 paid, 901 on roll: `accrueSeatArrears`
meters 501 seat-days a night onto `seatArrearsMinor`, and the top-up charges the
metered past PLUS forward cover for the time left. Live, after one sweep over a
7-day window: forward ₦1,645,986.44 + arrears ₦146,125.20 = **₦1,792,111.64**,
which is exactly what `TrueUpCard` renders; settling it took seats 400 → 901,
arrears → 0, and left `currentPeriodEnd` UNTOUCHED — a top-up buys seats, not
time. Unsettled, the same arrears ride the next renewal automatically. The meter
runs backwards ON PURPOSE: a forward-only quote SHRINKS as the term runs down,
so delay used to be worth money to the school.
**WHAT WAS WRONG WAS THE VISIBILITY.** The attention queue flagged which schools
had arrears and **never said how much** — a fact an owner can do nothing with,
since whether to ring a school about unbilled growth is a decision about an
amount, and the amount was already on the row. And nothing anywhere ADDED IT UP,
so "what are we owed?" had no answer in the product. `OperatorSeatArrearsDto` on
the revenue ledger, per currency, beside subscriptions and the take-rate. Live:
`901 pupils against 400 billed seats — NGN 146,125.20 metered and not yet
billed`, and `[{currency:"NGN",amountMinor:14612520,schools:1}]`.
// It is a POSITION, not a period figure — what is owed RIGHT NOW — so the
ledger's date filter deliberately does not touch it. Narrowing it to a reporting
window would answer a question nobody asked with a number that looks like the
one they did.
// GOTCHA, and the reason `strandedMinor` exists: **part of this debt can never
be collected automatically.** Every collection point refuses cross-currency
arithmetic — the renewal guards on `arrearsCurrency === currency`, and it is
RIGHT to: there is no FX rate in this platform and inventing one to move a debt
would be worse than the debt. But ENTERPRISE is USD-priced, so a school moving
up from a naira tier leaves its naira arrears behind, skipped by the top-up and
by every renewal, silently and for ever. The fix is to NAME it, not to convert
it: the ledger reports how much of each currency's arrears belongs to a school
that now renews in a different one.

### One field meaning two things, and a charge nobody could stop
Asked whether the tier and modules are captured accurately and the flow is
consistent. `resolveModules`, `PLAN_MODULES` and the `@RequireModule` gate are
sound; three things around them were not, and all three were proved on the
running stack before being touched.
**AN OPERATOR PUT DELETED EVERY ADD-ON.** `setSubscription` read
`input.overrides?.enabled ?? []` and WROTE IT ON EVERY CALL, while `status` and
`currentPeriodEnd` — in the same object literal fifteen lines below — correctly
treat an omitted field as "leave it alone". `plan` is required on every PUT, so
any save that did not resend the toggles wiped every module the school had
bought and every module the operator had comped. Live: ULTIMATE + a purchased
hostel add-on, saved as `{plan:"PREMIUM"}`, came back `enabled: []`. The console
always sends the toggles it last read so the UI never showed it — but that is
also a LOST UPDATE: an add-on bought while the operator has the page open is
erased by their next save. Now absent means unchanged; an EMPTY object still
clears, because that is a decision; a NEW row still gets an empty set, because
there is nothing to preserve.
**`overrides.enabled` MEANT TWO DIFFERENT THINGS.** A module the school BOUGHT
and a module the operator COMPED were stored identically, so they answered the
delinquency question identically — and a school that stopped paying lost fifteen
tier modules and KEPT every add-on it had ever bought. Live: ULTIMATE, 400 days
past due, effective plan STANDARD, hostel still on. An add-on is billed AT
RENEWAL and there had been no renewal. `ModuleOverrides.purchased` is the subset
that was paid for, written only by the add-on settlement path;
`overridesUnderDelinquency` drops those when `eff !== plan` and keeps the comps
— a comp is the owner's decision about that school, not something the school
failed to do, and dunning silently reversing it would surprise whoever made it.
// The stored overrides are UNCHANGED: the withdrawal is a resolution rule, not
a write, so paying restores the module with no repair step, exactly as paying
restores the tier.
**AND THERE WAS NO WAY OUT.** Nothing in the API removed a module from
`overrides.enabled` — a school could start a recurring charge in ONE CLICK and
the only exit was an operator hand-editing the subscription JSON. A recurring
charge a customer cannot stop is not a product decision, it is a missing screen.
`POST /billing/addons/:module/cancel` + `overrides.cancelling`: billing stops at
once (`billableAddons` prices every quote, checkout and auto-renew, so excluding
it there IS "stop billing me"), the module stays ON until `currentPeriodEnd`
because the last charge covered that period, and the RENEWAL that rolls the
period calls `dropCancelledAddons` and actually removes it. Buying it again
cancels a pending cancellation, which is what pressing "buy" plainly means.
// NO STEP-UP on the cancel, where the purchase has one — named in
`step-up-is-consistent-within-a-permission` with the reason: re-authentication
guards the act that COSTS money, and making the exit harder than the entrance is
the direction that list exists to keep straight.
// GOTCHA: the pure helpers all passed with the service still resolving against
the raw overrides, and with the settlement path never calling
`dropCancelledAddons`. Both were caught only by MUTATING THE FIX and watching a
green suite stay green — so the delinquency rule is exercised through the real
`ModuleEntitlementService` and the withdrawal through the real settlement path
in `billing.service.e2e`. A test on a helper proves nothing about its callers.
// GOTCHA while probing: changing `school_subscription.plan` directly in SQL and
re-reading through the API shows the OLD plan for up to ten minutes — the
entitlement cache is `CACHE_TTL_MS = 600_000` and only an application write
invalidates it. The first version of this probe reported no bug for that reason.

### Two seconds on the busiest finance screen, and a ledger that could not say what was bought
Asked whether the fees browser and the finance report are accurate AND efficient
now, and for a ledger of everything a school pays the platform. Three findings.
**THE SUMMARY WAS 2.3 SECONDS AND THE LIST WAS 0.6 MILLISECONDS.** Measured as
`major_user` with the tenant GUC set (never as `postgres`), on ten years of a
real secondary school — 185,413 invoices, 156,537 payments. The invoice LIST is
fine: `Index Scan`, **0.58 ms**, the `20270101000000` index earning its keep. The
SUMMARY above it and the receivables REPORT were not: **2,280 ms** and
**2,394 ms**, on every load of /fees, /admin and /fees/reports. One cause, in
both: `AND p."invoiceId" IN (SELECT id FROM billable)` made the planner
nested-loop `payment_invoiceId_idx` **once per invoice** — 185,413 index
lookups, 712k buffers, spilling to disk. RLS already confines `payment` to the
school; the subquery was never doing the scoping, only twisting the planner's
arm. Uncorrelated: **542 ms** and **571 ms**. Over HTTP at that volume the page
reads now go 455 ms and 816 ms.
// GOTCHA: NEITHER FORM WINS BOTH SCOPES, so `invoiceSummary` branches on the
one it already knows. Whole school: IN-subquery 2,280 ms, uncorrelated 542 ms.
ONE FAMILY: IN-subquery **5 ms**, uncorrelated **228 ms** — aggregating the
whole school to answer about one child. `financeReport` needs no branch: a
parent gets `scope: "none"`, so it is billing-wide by definition.
// GOTCHA: covering indexes were BUILT and MEASURED alongside
(`payment (invoiceId) INCLUDE (amountMinor, kind) WHERE status='POSTED'` plus an
invoice equivalent) and the planner never chose the invoice one; the pair moved
542 ms to 448 ms, inside the noise. Neither is added — an index nothing selects
is write amplification on the two hottest tables in the product, the same
conclusion as the three trigram indexes dropped in `20261228000000`.
**A LEDGER LINE WHOSE PURPOSE YOU HAVE TO INFER.** `/operator/payments` is the
owner's record of what every school has paid, and it showed the plan, the cycle
and the kind as three columns of raw enum codes plus a single period END. So it
could not say WHAT was sold — every add-on read `ADDON` though the row carries
`addonModule`, and a five-year purchase was indistinguishable from a one-month
renewal because `billingPeriods` never left the API — nor WHERE the school is,
nor HOW LONG the money bought, nor WHEN it was paid: the column headed "Date"
was `createdAt`, **the moment checkout STARTED**, so a charge begun on the 31st
and settled on the 1st was filed in the wrong month. Every one of those facts
was already on the row and none reached the screen. Now: `describePlatformCharge`
(pure, shared by table and CSV so they cannot drift) writes the sentence; the row
carries `region` (country NAME + the school's OWN currency, which is NOT the
charge currency — a Ghanaian school can be billed in USD), `tenorDays` with
`periodStart → periodEnd`, `billingPeriods`, `promoCode`, `arrearsMinor`
(INCLUDED in the amount, so a ledger that stays silent reports settled debt as
new revenue) and who initiated it. // A charge that buys NO time — a seat top-up,
an add-on — reports `tenorDays: null` and says so, rather than borrowing the
subscription's window and counting the same tenor twice across two rows.
**AND THE PLATFORM SOLD SOMETHING AND KEPT NO RECORD OF THE MONEY.**
Message-credit bundles are sold through Paystack like any other charge.
`applyPurchase` read the amount off the signed event, compared it to the bundle
price so a short payment could never credit a bundle — **and then discarded it**,
writing a row carrying the credits granted and nothing about the money. Two
consequences: the revenue ledger reads `platform_subscription_payment`, which a
bundle never touches, so this line appeared on NO screen in the product; and
since the figure was never persisted it could not be recovered from our own
database at all, only from the gateway's. `message_credit_entry.amountMinor /
currency / bundleId` (migration `20270106000000`, all NULLABLE — a SEND is not a
payment, and a purchase settled before the column cannot say what it was; NULL
means "not a recorded payment", which the screen prints as "not recorded" rather
than 0.00). Shown as its OWN list beside the subscriptions, not rows in that
table: a bundle has no plan, seats or period, and empty columns read as missing
data rather than inapplicable ones. Partial index on `("createdAt") WHERE reason
= 'PURCHASE'`, because that table grows with every message SENT, not with the
number of purchases.
// GOTCHA: `money-boundary`'s bigint gate went red on the COMMENT explaining why
the new code does not write `.amountMinor as number`. Its sibling
`money-is-not-divided-by-a-hundred` already strips comments and says why — "a
scan that reads prose fails on the explanation of its own fix". This one did
not. Fixed there, and mutation-validated: the real cast is still caught.

### A total that added two currencies, on six screens at once
The user asked whether the accountant's and the platform owner's dashboards
report naira and dollar fees accurately. They did not, and the reasoning had
already been written down THREE times in this codebase by somebody who had met
the same bug elsewhere:
- `group.service.ts`: "a payment carries no currency of its own — it inherits
  its INVOICE's. So the collected figures join through to the invoice rather
  than assuming NGN, **which is precisely the assumption that made the old
  totals wrong**."
- `operator-payments.service.ts`: "money is NEVER summed across currencies …
  **the shape of the answer is what stops the mistake being reintroduced**."
- `platform-analytics.service.ts`: "kobo added to cents … **a bug with a start
  date**."
Each was fixed where it hurt. Six siblings were live:
**ACCOUNTANT.** `invoiceSummary` (/fees and /admin) summed every currency AND
returned the literal `currency: "NGN"` — so a Ghanaian school read its own
receivables labelled in naira. `AnalyticsService`'s fees block was an ungrouped
SUM, rendered by a KPI card calling bare `money()` **directly above a chart that
had already been corrected to the school's currency** — one page disagreeing
with itself. `financeReport` (/fees/reports) summed totals, four aging buckets
and pending approvals. The analytics CSV exported `Invoiced (minor)` with no
currency at all, into a board pack.
**PLATFORM OWNER.** `listAgents` grouped commissions by `["agentId","status"]`
and dropped the `currency` column the table has always carried — a PAYOUT
figure, kobo plus cents. The operator dashboard's six-month revenue TREND added
every currency **twenty-five lines below the loop that deliberately does not**,
and `recentPayments` shipped an amount with no currency for the screen to guess
at. `student-exit` summed a leaver's invoices two ways, on the screen where a
transcript is released or withheld. The group console's per-campus monthly trend
summed across currencies **in the same file whose `moneyByCampus` gets it right
and says why**.
Fix: every aggregate now returns a currency with the money. The SCHOOL's own
currency leads and is ALWAYS PRESENT even at zero — the tiles read that slot as
"our money", and promoting a USD figure into it because it happened to be the
only one this term is the same wrong answer in a new place. `byCurrency` carries
the rest; nothing is converted, because there is no FX rate here and inventing
one would be worse, the decision `school.paymentApprovalThresholdMinor` already
records. A single-currency school — nearly all of them — reads exactly what it
read before. Efficiency: grouping is one more column on the same scan, one round
trip, no new query.
**THE TAKE-RATE WAS WRITTEN AND READ BY NOTHING.** `payment.platformFeeMinor` is
stamped on every settled online payment by the settlement path, and the string
appears in ZERO web files, ZERO DTOs and ZERO endpoints — the owner who sets the
rate had no way to see what it earned. Subscriptions had a ledger; the lever the
whole fee rail exists to monetise did not. Now `OperatorFeeRevenueDto`, per
currency (joining through the invoice), on /operator/payments. Only the DATE
RANGE of the filter applies: plan, status and school search describe SUBSCRIPTION
payments, and reinterpreting them would move the figure for reasons its label
does not explain. Measured as `postgres` — correct HERE and only here, because
this read runs on the PRIVILEGED client which bypasses RLS — on 404,517 payments
over five years: 30-day report **60.0 ms Parallel Seq Scan -> 12.7 ms Bitmap
Index Scan** with a PARTIAL index on `("createdAt") WHERE platformFeeMinor > 0
AND status = 'POSTED'` (migration `20270105000000`). The LIFETIME figure still
seq-scans at 80 ms and correctly so — it wants most of the table — which is
recorded rather than papered over, because that one grows with the platform's
age. // GOTCHA: the first fixture packed 400k payments into a 120-hour window,
so a 30-day range selected nearly all of them and measured the wrong thing;
redistributed over five years it is 1.2% of the table. Same trap as the invoice
index.
Gate: `a-money-total-says-what-currency-it-is.spec.ts`, and **it found the
sixth and seventh sites itself** (the group trend and the leavers list) after I
had written a false exemption claiming the leaver balance was already
per-invoice. // GOTCHA, three false negatives, each caught ONLY by mutating the
fix the gate exists for: (1) matching `GROUP BY … currency` missed `GROUP BY 1,
2`, which three of them write; (2) reading "everything before the first FROM"
reads the first CTE, not the answer — `financeReport` opens `WITH billable AS
(SELECT id, currency, …)`, so deleting the currency from the final SELECT left
it green; (3) the per-invoice escape hatch matched a `net` CTE's internal
`GROUP BY invoiceId` inside every statement, so the hatch covered everything.
It now walks to the LAST `SELECT` at paren depth zero. // GOTCHA on the Prisma
half: `groupBy` is aliased through `as unknown as (args) => Promise<Array<{ …
currency … }>>` because the generated overload cannot express a three-column
`by` — so reading the call after `x.groupBy(` reads the TYPE ANNOTATION, which
names `currency` whatever the `by` list says. Aliases are resolved to where they
are INVOKED. Exemptions are COUNTED, not named: a bare file-level pass is what
let `money-is-not-divided-by-a-hundred`'s GrowthManager entry — granted for
`commissionBp / 100` — quietly cover a `minor / 100` money formatter that landed
later. That formatter is gone too.

### A credit balance was a number, with nothing said of what money it was
Found by RUNNING a path that had never executed: `student_credit_entry` had
zero rows, so prepay, overpayment and apply-credit had never once been
exercised end to end. `deltaMinor` was recorded with NO currency, while every
row that feeds or spends it carries one — an OVERPAYMENT is in the source
INVOICE's currency, a dedicated-account transfer is in the CHARGE's, APPLIED
spends into the TARGET invoice's — and invoices carry their own currency PER
ROW, because the platform bills USD through Stripe alongside a school's local
currency. So the balance was a sum over two kinds of money.
Measured live on the running stack: two guardians raced to settle one $100 USD
invoice (`applyOnlinePayment` reads the status and then writes, so a genuine
race still overpays — the manual path refuses an over-balance payment, which is
why this is the ONLY way in), the $100 excess moved to credit as `10000`, and
applying it to a naira bill credited **10,000 KOBO — ₦100 against $100**, about
a thousandth of it, with `{"appliedMinor":10000}` and a PARTIALLY_PAID invoice
reporting success to the family. The reverse is worse: ₦100,000 of overpayment
is 10,000,000 kobo and would credit **$100,000.00**.
// GOTCHA, and the reason this is a gate rather than four fixed call sites:
**it was not that nobody had thought about it.** `initPrepay` raises its charge
in the school's own currency and says why in a comment — "crediting a ledger in
one currency from a charge in another is a balance that silently drifts". One
producer of four, and neither of the two consumers. The dedicated-account
handler is the sharpest case: it passes `event.data.currency` to
`applyOnlinePayment` on the branch where an open invoice exists, and passed
nothing at all to the credit branch four lines below.
`student_credit_entry.currency` (migration `20270104000000`) is NULLABLE and
NULL means the SCHOOL's own currency — rows written before the column cannot
say what they were, and that is the only assumption the data supports; a
backfill would record the guess as a fact. // GOTCHA: `creditCurrencyWhere`
must match NULL **for the school's currency and no other**, or every historical
row becomes unspendable — a family's money still on the screen with no invoice
able to take it. `CreditBalanceDto` now carries `currency` + `balances[]`;
`balanceMinor` stays the school's-currency figure, so a single-currency school
reads exactly what it read before. Credit is spendable only on an invoice in
its own currency: there is no FX rate here and inventing one to spend a balance
would be worse than refusing, the same decision
`school.paymentApprovalThresholdMinor` records. The refusal DISTINGUISHES "no
credit" from "no credit in THIS currency", because the second is visible on the
pupil's other invoice and would otherwise be reported as a bug.
// GOTCHA on the same panel, found while fixing it: `CreditPanel` was handed
`currency={inv.currency}` and rendered the one balance under it — the same
ledger read `$100.00` on a dollar invoice and `₦100.00` on a naira one, for one
pupil on one afternoon — AND labelled the top-up box with the invoice's
currency while `initPrepay` charges in the SCHOOL's, inviting a parent to type
dollars and be charged naira.
Gate: `every-credit-row-says-what-money-it-is.spec.ts` fails on any
`studentCreditEntry` write with no currency, reading each `data` block to its
matching paren rather than a fixed window. It asks about the WRITE, not the
read: a read that forgets renders a wrong symbol, a write that forgets destroys
the fact for ever. Mutation-validated three ways — drop the filter, drop the
stamp, break the NULL case — each caught by the test written for it.
LIVE-VERIFIED after: same probe, $300 overpaid -> a USD credit row, the naira
`balanceMinor` reads 0, and applying to the naira invoice is a 400 naming the
reason with the invoice left ISSUED and no payment written.

### The safety net nobody was told about
`audit_log` is RANGE-partitioned by month with a DEFAULT partition, so an INSERT
can never fail for want of one — and that safety net IS the risk: when a month
goes un-provisioned nothing breaks, rows just pile into DEFAULT, and per the
service's own comment they "must be migrated into a real partition before one
can be added for their month", which gets harder the longer nobody looks.
`AuditPartitionService` provisions three months ahead daily, counts the DEFAULT
partition afterwards and logs at ERROR when it is non-empty. All correct. But
the OPERATOR'S JOBS CONSOLE decides its "Partial" badge from a NUMERIC `failed`
in the stored run summary — an opt-in convention, so a job reporting none
renders healthy for ever. This job reported none, so **the one condition the
sweep exists to detect flagged nothing**; `defaultRows` did reach the console,
in the text position used for ordinary chatter beside every green row.
**TWO SEAMS, and fixing the first alone would have looked right and changed
nothing.** The service computes the result, but what the PROCESSOR returns is
what gets stored — and it mapped the result field by field, dropping `failed` on
the floor. A unit test on the service would have gone green over a console still
showing the row as healthy, which is why the test drives the real processor.
Third instance of one lesson, after the retention and dunning sweeps: **a count
nobody surfaces is a count nobody acts on**, and both siblings got `failed`
while this one did not.
LATENT, not live: the job runs daily, partitions reach 2026-11, and
`audit_log_default` is empty. What was broken is the telling, not the doing —
verified by writing an audit row dated outside every partition range, watching
it land in `audit_log_default`, and reading it back through the service's own
query. // GOTCHA: partitions are created by a JOB, not by the migration that
made them — the migration covers a fixed window and its comments name the job
twice. A partitioned table whose extender stops is a bug with a start date, the
same shape as a payroll pack that hard-codes one tax year.

### Thirteen controls that remove something and announce nothing
`every-control-has-a-name` covered text ENTRY — `<input>`, `<select>`,
`<textarea>` — and said nothing about the controls people PRESS. Of 1,009
pressable controls (91 `<button>`, 648 shadcn `<Button>`, plus links), **13 had
no accessible name at all**: eight `✕` buttons that REMOVE a record (an invoice
line, a pay component, a duty assignment, an award, a lesson block, an
instalment, a biometric device, a device enrolment), `↑`/`↓` for reordering
lesson blocks, and `P`/`L`/`A` on the STAFF ATTENDANCE register.
A screen reader announces `✕` as "multiplication sign" and `P` as "P": the user
is told a control exists and not what it does, and every one of the eight
destroys something. The register case is worse than cosmetic — three
single-letter buttons per row, repeated down a list of staff, with nothing
saying which person the row belongs to.
Each label now names WHAT it acts on, because a label is heard OUT of visual
context: "Remove instalment 2", "Mark Demo HR Clerk present", "Unassign Gate
duty from Demo Driver" — never a bare "Remove", which is the same problem one
word longer. The gate now asks the same question of `button`/`Button`, with
`ui/button.tsx` exempt for the reason `ui/input.tsx` already is: a primitive
FORWARDS children, and a name hard-coded there would be wrong on every caller.
// GOTCHA, and it made my first scan useless: stripping `{...}` expressions to
find "text" deletes the very thing that names most buttons — `{s.userName}`,
`{open ? "Hide" : "Show"}`. That reported 32 offenders, nearly all false. A
rendered expression IS a name; what announces nothing is an icon, an
`aria-hidden` span, or a bare symbol. Counting those properly gives 13.

### The staff page showed "Staff member" where a name should be
The type-safety spine says a read controller annotates its return type
(`: Promise<XDto>`) "so a service that drops/mistypes a field fails to compile".
**83 of 360 GET routes had no annotation at all** — 10 more are binary/CSV
streams, where a DTO would be wrong. For 15 of those 83 the WEB nonetheless
asserted a named DTO through `apiGet<T>`, which is an unchecked cast: a contract
the consumer relies on and the producer never promised, and one the
`wire-shape-agrees` gate has to SKIP because it can only compare handlers that
declare something.
Annotating them is a CHECK, not documentation. Twelve were annotated; eleven
compiled, and the twelfth failed immediately: `GET /hr/employees/:userId`
returned a shape with no `user`, while `EmployeeDto.user` is declared
`{ name, email } | null`. **`employee` has no name of its own — it hangs off
`user`** — and `listEmployees` says exactly that in a comment and joins it, two
methods above a `getEmployee` that did not. Sibling asymmetry with the correct
one written FIRST and its reasoning recorded beside it.
The cost was on screen. With no name on the record, the staff detail page
scavenged one from whichever of five UNRELATED lists happened to carry a row —
checklists, documents, training, appraisals, discipline — and fell back to the
literal `"Staff member"`. Measured live before the fix: `hr@demo.school` and
`board@demo.school`, real employees holding none of those five, BOTH rendered
"Staff member" as the page title. Every newly-recorded employee reads that way.
// GOTCHA: the LIST was wrong too, in the other direction — it attached the
whole user row including `id`, which `EmployeeDto.user` does not declare. Both
reads now return exactly `{ name, email }`, so the test can assert AGREEMENT
rather than either read alone.
// GOTCHA worth keeping: the mutation that removes the join again does not fail
a test — it fails to COMPILE, because the annotation is now the guard. The test
covers what the annotation cannot express: that the single read and the list
read say the same thing about the same field.

### The banner counting unanswered chargebacks could not see the old ones
`GET /fees/disputes` was `take: 200` ordered newest-first, with no filter, no
paging and no total — on a table the controller's own comment calls permanent
(rls/78 grants no DELETE). The truncation was not the worst of it. The page
computed its warning banner as a MEMORY filter over those 200 rows:
`disputes?.filter((d) => d.status === "OPEN").length`. A dispute stays OPEN
precisely because nobody has answered it, so OPEN rows AGE — and newest-first
drops the oldest off the end. **The rows the count existed to surface were
exactly the rows it could not see**, and the page's own subtitle says an
unanswered dispute is "lost by default", which is money.
Measured on a real school seeded to 251 disputes: the old query returned **200
rows containing ZERO open ones**, while a dispute sat OPEN with an evidence
deadline of 2025-10-29 — not in the 200, and reachable by no filter the product
offered. After: banner "1 open dispute", footer "Showing 1–50 of 251", both
matching the database exactly.
`list` now filters IN SQL (`status`, `q` over either reference the row carries)
and pages, returning `PaymentDisputePageDto`. // GOTCHA: `openTotal` is counted
in SQL and is deliberately SCHOOL-WIDE, never narrowed by the current filter —
verified live, `?status=WON` shows "Showing 1–50 of 250" while the banner still
reads 1 and says "(school-wide, not just this filter)". A count that a search can
change is a count a search can hide, and the banner answers "is anything waiting
on us", not "how many did I just search for". The banner also renders ABOVE the
empty/error branches, so a filter matching nothing cannot suppress it.
Two states that must not be confused, both live-verified: an unmatched filter
says "No disputes match this filter", and an invalid `status` is a 400 that
renders the LOAD-FAILURE card — never "No disputes recorded", which is a
statement about money a finance officer acts on. Indexes already covered it
(`schoolId,createdAt` Index Scan Backward, 0.126 ms/50 rows as `major_user` under
RLS; `schoolId,status` for the count), so no migration.
Third instance of the class already recorded for approvals, leave and
assessments: **filtering in memory still only ever sees the rows that survived
the cap.**
**AND ITS SIBLING HAD IT TOO.** Rather than stop at the one that hurt — the
mistake this repo keeps recording — the class was swept: of the 128 tables the
app role cannot DELETE from, 27 had a list read with a hard cap. `GET /admissions`
was byte-for-byte the same shape, `findMany({ orderBy: { createdAt: "desc" },
take: 200 })`, no filter, no page, no total. An application still NEW or
REVIEWING is one nobody has answered, so it ages the same way an unanswered
chargeback does, and newest-first drops the OLDEST — the family that applied
FIRST was the one the screen could not show. Measured on 251 seeded
applications: **200 rows, ZERO undecided visible**, and a NEW application from
400 days earlier reachable by nothing, on a page whose own comment already said
"a family waiting on a decision is the cost" — reasoning that had been applied
to a failed read and never to the cap. There was no status filter at all, so
"what is still waiting on us" had no answer short of reading every card. Now
`AdmissionApplicationPageDto` with `undecidedTotal` counted in SQL and
school-wide, `q` over child / applicant / email, and the same
filtered-empty-vs-load-failure distinction.

### Six gates each grew their own route extractor, and five were wrong
`apps/api/test/support/api-routes.ts` is now the ONE answer to "what routes does
this API declare". Six gates had each written their own, and five took the FIRST
`@Controller` in a file as the prefix for every route in it — three files declare
two — so four routes were filed under a path nobody can call:
`POST /public/careers/:slug/apply` read as `POST /hr/recruitment/:slug/apply`,
`POST /public/biometric/:slug/events` as `POST /hr/attendance/:slug/events`, and
`GET /students/profile-reviews` as `GET /students/:studentId/profile-reviews`.
**Two bugs were cancelling out, which is worse than either alone.**
`every-mutation-leaves-a-trail` carries NAMED EXEMPTIONS keyed on the route, and
one was written against the fictional `POST /hr/recruitment/:slug/apply`. It
matched only because the extractor was broken in the same direction. That list is
the record of which mutations deliberately go unaudited, and it named a route
that does not exist while a real PUBLIC write went past under a borrowed name —
and the file's own header comment misnamed the biometric endpoint the same way,
so the one real gap this gate ever found is recorded under a path you cannot
call. The fail-OPEN direction is the one that matters: `POST /hr/recruitment/
:slug/apply` is a plausible authenticated route, and the day somebody adds it for
real it arrives PRE-EXEMPTED from the audit gate by an entry written years
earlier for something else. `it("exempts only routes that exist")` now makes a
fictional key impossible.
**IT WAS SEVEN COPIES, NOT SIX, AND THE RIGHT ONE WAS ALREADY THERE.**
`test/surface/extract.ts` — not a `.spec.ts`, so the first sweep missed it —
already resolved the prefix by POSITION and documented the bug in detail,
naming `GET /public/careers/:slug` filed under `GET /hr/recruitment/:p` and
calling those "exactly the routes a surface gate is most for". Somebody found
it, wrote down precisely why it mattered, fixed the file in front of them, and
left the five siblings plus the audit gate's fictional exemption untouched.
`public-routes-are-rate-limited` was fixed the same way, separately, after the
same bug bit on the biometric endpoint. **Fixing the gate where it hurt and
leaving the siblings is the defect class this repo keeps finding in its
application code, committed twice over in the gates themselves.**
`extract.ts` now DELEGATES its walking and prefix resolution to the shared
extractor (route set identical before and after: 863 keys, none added, none
lost) and its own dead walker is gone. The rule is enforced rather than
remembered: `api-routes.spec.ts` fails if any file outside the shared module
captures the `@Controller` ARGUMENT to build a path — a bare existence check
stays legal, because `webhook-targets` uses one to fail loudly on a file it
cannot read. Mutation-validated by adding an eighth copy and watching it be
named. // GOTCHA: `extract.ts`'s prose said "and two do" when THREE files
declare two controllers — `sis.controller.ts` was the third, which is how
`GET /students/profile-reviews` came to be read as
`GET /students/:studentId/profile-reviews`.
// GOTCHA, and my first shared version had it: a block taken from "this route
decorator to the next" reads only what is written BELOW. `@Public()` is written
ABOVE `@Post(...)`, so `isPublic` was false for the careers intake, the biometric
ingestion and the payment webhook — the three routes any gate asking about public
routes exists to look at (19 detected, should be 26). Decorator ORDER is a style
choice a reader makes freely; a gate that depends on it goes quiet when somebody
swaps two lines. Hence TWO fields: `block` is the decorator RUN walked both ways
and answers `@Public`/`@RequirePermission`/`@RequireStepUp`; `body` is the
handler and answers what it CALLS. Conflating them made the audit gate extract
ZERO routes and still report no offenders — caught only by its own
"extracted a believable number" guard, which is why every such gate has one.
Permissions are returned SPLIT: `@RequirePermission(A, B)` grants on either, and
reading the argument list as one opaque string made such a route compare equal to
nothing but itself. Proved by making `SCHOLARSHIP_PERMISSIONS.APPLY` step-up-
gated: `POST /scholarships/applications/:id/decision` is flagged now and its
three single-permission siblings were flagged before — it alone was invisible.
LATENT, not live: no multi-permission route currently shares a permission with a
step-up-gated one. The prefix bug WAS live.
Related, and separately clean: every permission that gates an endpoint is granted
to some role (nothing unreachable), and the seven granted but gating no route are
enforced in a SERVICE (`attendance.amend.review`, `cbt.review`,
`subject.selection.approve`) or as CHAIN DATA in `STAFF_REQUEST_CHAIN`
(`workflow.review.head`/`.hr`) — a deliberate pattern, not an orphan.

### The accident gate now covers every test tree, and the HAYSTACK not just the needle
`assertions-that-match-by-accident.spec.ts` scanned only `apps/api/test` and
flagged numeric needles shorter than four characters. CI went red on
`packages/game-transport`'s duel spec — `JSON.stringify(frame)` asserted not to
contain the secret `"1234"`, over a frame carrying `randomUUID()` ids in which
`1234` is an ordinary hex substring: **0.045% per id, ~0.8% per run**, about one
red push in 125, on a test that is not wrong about anything. It failed on an
accessibility commit that touched no game code.
Two gaps, not one: the gate's ROOT (one directory — a gate that covers one tree
is one the next instance is written outside) and its RULE (four characters was
"specific enough", but specificity depends on the haystack — searching a whole
serialised object is the risky act however long the needle). It now walks
`apps/api/test`, `packages/*` and `apps/web`, skipping `node_modules` (symlinked
workspace packages report the same file three times), and follows the subject
back up to twelve lines because `const json = JSON.stringify(x)` on the PREVIOUS
line is the form that actually failed. A subject sanitised with `.replace(` is
accepted — that is the correct fix, and a rule that forced an allowance onto
every correct fix would be abandoned.
It immediately found FIVE more latent flakes of the same kind in `game-engine`
and `game-transport`. All six now strip ids before searching.

### A suspended school is TOLD, at the screen it actually reaches
`SCHOOL_SUSPENDED_CODE` (`@sms/types`) is the one value both sides agree on — a
literal on either side would be a contract nobody checks. The API's guard tags
its 403 with it; the web tells it apart from an ordinary permission 403, which
`apiGet` answers with `null` (right for a missing permission, useless here: every
read 403s, so the user would get page after page of empty cards and no reason).
// GOTCHA, found by driving it live: **the session revocation fires FIRST.**
`refreshClaims` revokes a rolling session for a switched-off school, so
`GET /dashboard` → `307 /login` and the user never sees `/suspended` — that page
is only the safety net for the window where a server component gets the 403 first.
The screen they ACTUALLY reach is the LOGIN page, and it was showing a catch-all
that listed suspension among several possibilities, sending people to check a
password that was never the problem. `authorize` now throws `CredentialsSignin`
with the code (surfacing as `?error=CredentialsSignin&code=SCHOOL_SUSPENDED`) and
the form says what happened, that nothing was deleted, and who can restore it.
A wrong password still gets the generic refusal — naming a suspension is safe
because nobody at the school can act on it either way, but naming which half of a
credential was wrong is an oracle.

### A switched-off school reaches NOTHING, and only the owner switches it back
DISABLED used to mean the front door only: the LOGIN was refused and everything
else went on working. `SchoolStatusService` (foundation, @Global, 15s cache +
Redis invalidation on the operator write) is consulted by `PermissionGuard` on
EVERY authenticated request, so a suspended school is refused wherever it knocks
— measured live: a staff session open at the moment the switch was thrown went
from 200 to 403 on its very next request. Also closed: `refreshClaims` now
revokes a rolling session (it checked the USER's status and never the school's,
so an open session refreshed indefinitely), invite-accept and password-reset
refuse, the public login-page BRANDING stops resolving, and subscription dunning
skips it (a "renew now" to admins whose login is blocked is a loop that cannot
close).
SUPER_ADMIN IS EXEMPT everywhere, deliberately: the lever that switches a school
back on lives in the operator console, and locking it inside the thing it
controls is how a school stays disabled for ever.
REINSTATEMENT IS TOTAL because disabling writes ONE COLUMN and deletes nothing —
subscription, balances and due dates are all still there, so switching it back on
restores the school to its original and due state with no restore step. A test
pins that `setSchoolStatus` performs no cascading write, because the day somebody
adds one is the day that stops being true. `platform.tenants.status` (super_admin
only) + step-up gates the lever at both ends.
// GOTCHA: an unknown school reads as INACTIVE, not active — the restrictive
option, and the alternative is serving a tenant nobody can account for.

### A school the operator switched off is left alone
`DISABLED` is the hard lever and auth states what it means — it "blocks ALL of its
members' logins", deliberately unlike PAST_DUE, which only degrades modules so a
school can still reach `/billing` and pay. Two nightly sweeps did not know: both
`lateFeeSweep` and `reminderSweep` selected `{ isPlatform: false }` with NO status
filter, so a switched-off school went on adding a late fee to its parents'
invoices every night and emailing them about the balance IN THE SCHOOL'S NAME —
while nobody there could sign in to see it, stop it, or answer a parent who rang.
Both now require `status: "ACTIVE"`.
DELIBERATELY NOT changed, and a test pins each: RETENTION still purges a disabled
school (the obligation to delete minors' telemetry on time does not pause because
a school stopped paying, and nothing about a purge reaches a person), and the
attendance rollup and term roll-over still run because they move only internal
state that must be right if the school is switched back on. The operator and
reporting reads deliberately include disabled schools — an operator has to see
them, though the lapsed-subscription digest now LABELS one "SWITCHED OFF; nobody
there is being chased", because "12 days past due" beside a school the owner
themselves suspended reads as a school to ring.

### Nothing reaches a switched-off school, and no money posts to it
The owner's decision, and it closed the last two ways in. Both are fixed at a
FUNNEL, not at the producers.
**Money**: `InvoiceSettlementService.applyOnlinePayment` refuses when the school
is not ACTIVE, BEFORE it reads the invoice. It is the one posting path, so this
covers card, mobile money, dedicated NUBAN, both verify-on-return routes, the
reconciliation sweep and any rail not yet written. The routes in are ordinary: a
checkout opened before the switch was thrown still calls back, and a NUBAN
transfer needs no session at all. It does NOT throw — the callback still gets
2xx, because a non-2xx makes a rail retry for days and retrying will not make
the school active. // GOTCHA: **the payer has already been debited**, so
refusing is only recoverable because somebody is told: it logs at ERROR and
raises an OPERATOR_ALERT naming the school, amount and gateway reference, so the
choice between reinstating and refunding reaches a person. No sweep will do it —
reconciliation looks back three days and a suspension lasts as long as it lasts.
**Words**: `NotificationService.persist` drops EXTERNAL channels for a school
that is not ACTIVE, right beside the twin rule for a recipient who has left. The
fee-reminder and late-fee sweeps had been stopped for this already; that was two
sweeps, not the rule, and the overdue-boarder alert, the chargeback warning to
finance and the HR document-expiry reminder still went out.
**The in-app row is still written**, deliberately: disabling deletes nothing and
reinstatement is total, so the notices a school missed are part of its original
and due state, and nobody can read them meanwhile anyway. Operator alerts need
no exception — they are enqueued into the PLATFORM org's tenant, so the school
being asked about is the platform.
Both guards fail OPEN on an unreadable status: an absent dependency must not
silently stop every school's email.
Live: signed webhook to a DISABLED school -> HTTP 201, zero payments, ERROR
logged, owner alerted (delivered, since the platform org is ACTIVE); school
switched back on, same charge replayed -> POSTED.

### Two surfaces the guard cannot reach, and both are now asked
`PermissionGuard` sees HTTP requests. Two ways in are not HTTP-shaped and had
their own answer to "may this tenant be here" — neither of which asked.
**A WEBSOCKET UPGRADE** verifies the ws-ticket and expands roles to permissions;
that is all. A ticket minted moments before the switch still opened a socket,
and an ALREADY-OPEN one pushed live state for as long as it stayed connected,
because a socket that never reconnects is never re-authorised. Hence TWO checks
in `GameSocketGateway`: at the handshake, and inside `pushView` BEFORE the
durable read — the socket's equivalent of the guard running per request. Closes
4403 with `SCHOOL_SUSPENDED_CODE`; super_admin exempt at both, same reason as
the guard. Measured live: the same ticket gets `NOT_FOUND` while the school is
on, `SCHOOL_SUSPENDED` + close 4403 while it is off, and `NOT_FOUND` again once
it is switched back on.
**A SIGNED UPLOAD LINK** (`/public/documents/*`) is `@Public` and authorised by
the token alone, so a family holding one issued before the switch went on
sending a child's birth certificate into a school that could not open it — and
was told each time that it had been received. All three routes resolve their
subject through `subjectOf`, so the check lives there. // GOTCHA: the message is
deliberately DIFFERENT from the bad-token one. A bad token is answered vaguely
because the asker is unauthenticated and which-check-failed is information; this
family holds a VALID link, the suspension is not a secret from them, and
"not valid or has expired" sends them chasing a replacement that cannot help.
The forged-token path still gets the vague message — verified live alongside.

## Repo workflow & gotchas
- DB setup order: `prisma migrate deploy` → `pnpm --filter @sms/db rls` →
  `prisma db seed` (or `pnpm --filter @sms/db setup`). RLS lives in `prisma/rls/`,
  NOT prisma migrations — Prisma's shadow DB rejects the `major_user` GRANT.
- **The migration history REPLAYS from scratch — keep it that way.** It did not
  used to: `20260713020000_multi_currency_billing` ALTERs `plan_price`, a table
  not CREATEd until the LATER-stamped `20260726000000_plan_pricing`, so a fresh
  `migrate deploy` died on `relation "plan_price" does not exist` (P3018/42P01).
  The folders were simply mis-stamped — every already-migrated DB ran them in
  AUTHORING order (plan_pricing Jul 9, multi_currency Jul 13) and is consistent.
  It is fixed by a trio that touches no historical file, since renaming or
  reordering folders would break the checksum every already-migrated environment
  has recorded: `20260713010500_plan_price_replay_bootstrap` creates the table
  early IF ABSENT (marker COMMENT), `20260725999999_*_drop` removes it again
  ONLY if it still carries that marker, and `20260726000001_*_repair` re-applies
  the multi-currency column + composite PK idempotently. All three are no-ops on
  an already-migrated DB. // GOTCHA: without the third one `migrate deploy`
  reported SUCCESS while producing a single-currency `plan_price` — a silent
  divergence from production, strictly worse than the loud 42P01 it replaced.
  So a fresh DB is now built the SAME way production is: `migrate deploy` +
  `pnpm rls` + seed. **CI does this too, deliberately** — `db push` only knows
  the Prisma schema, and 31 FKs live only in migrations (the documented "scalar
  column + DB FK, no Prisma relation" pattern that keeps the `User` model lean,
  plus a dozen whose migration ON DELETE differs from Prisma's default), so
  `db push` gave CI 287 FKs against production's 318 — tests passing on
  referential integrity production lacks. It also means a broken migration now
  fails CI instead of failing on deploy.
- RLS files use bare `CREATE POLICY` (Postgres has no IF NOT EXISTS for it), so
  they are order-sensitive, not idempotent — the entrypoint applies them per-file
  against a sentinel. `02_foundation_rls.sql` is the ONE exception: its two
  `audit_log` policies DROP-then-CREATE, because `20260824000000_audit_log_
  partition` re-declares those same names. Without that, 02 aborted partway on
  any migrate-deploy DB and silently left the rest of the file unapplied.
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
- Tests: **`pnpm --filter @sms/api test:db` runs ALL of it.** A bare `jest` runs
  3,619 tests and SKIPS 28 suites (396 tests, the RLS e2e among them) because
  every DB-gated spec `describe.skip`s without `TEST_DATABASE_URL`. CI supplies
  the variables and runs 4,015, so **a green local run says nothing about a
  quarter of the suite** — CI sat red for three days (0 of 71 runs after 17 Aug
  2026) on three of those tests and no local run could have shown it. The script
  reads `infrastructure/.env` and points at the `sms-test-pg` container on 5434.
  It needs FOUR variables, not two, and each was found by hitting it: the raw-pool
  RLS spec takes `TEST_DATABASE_URL` (app role) + `TEST_ADMIN_URL` (superuser, to
  seed across FKs); the Prisma-backed service e2es go through the `@sms/db`
  singleton and need `DATABASE_URL`; and the storage stub signs presigned URLs
  with `AUTH_SECRET` — without it the report-card vault write fails, is SWALLOWED
  by a best-effort catch, and the test fails two assertions later on a status.
  All are declared in `turbo.json` `test.passThroughEnv` — Turbo 2 strict env
  will otherwise SKIP the suite. // GOTCHA: on main the DEPLOY workflow fails on
  every push and always has (no AWS credentials), so "a red run" is ambiguous —
  check WHICH workflow with `gh run list --workflow=ci.yml`.
- EVERY DB-gated e2e suite must `await prisma.$disconnect()` (the `@sms/db`
  singleton) in `afterAll`, even if it only touched the DB via a service — an
  undisconnected pool keeps the jest worker alive and HANGS the CI test step
  indefinitely. `--runInBand` locally masks it (another suite's disconnect in
  the shared process closes it for everyone), so a suite can look fine locally
  and still hang CI. Cleanup ordering: `audit_log` rows reference users
  (`audit_log_actorId_fkey`), so delete them BEFORE the suite's `"user"` rows.
- Seed permission registry: `seed.ts` upserts the UNION of its hand-listed
  `PERMS` and every key `ROLE_PERMISSIONS` references (`ALL_PERMS`) — a
  permission added to the role map in `@sms/types` can no longer crash the
  seed or silently miss the DB. A LIVE DB only gets new permissions when the
  seed RE-RUNS (compose seeds on first provision only) — after adding a
  permission, run the seed against the live DB or the new endpoint 403s
  even for super_admin.
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
  `junioradmin@` /
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

**FULL-STACK VERIFIED end-to-end (2026-06-27) against a real Postgres 18 (UTC)
— a SNAPSHOT OF THAT DATE, and its counts have since grown (24 RLS files → 112,
71 RLS-enabled tenant tables → 196, 298 api tests → 4,000+). Read the numbers
below as what was true then. What keeps coverage honest TODAY is not this
paragraph but the gate: `rls.e2e-spec.ts` introspects `pg_class` for every table
carrying a `schoolId` and fails if one lacks a cross-tenant case, so the set
under test is computed rather than counted by hand. `ultimate_participant`
remains the one documented exemption, still true.**
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
kobo, audited, `disbursementPaymentId` links back. // GOTCHA: an award is denominated in the
PLATFORM's currency and the invoice it lands on is the SCHOOL's, which is a
free-form ISO code — and nothing compared them, so ₦50,000 (5,000,000 kobo)
posted against a GBP invoice credited £50,000 and against a franc invoice
5,000,000 francs, marking it PAID while the books recorded fifty thousand naira.
`disburseFeesCredit` now refuses a mismatch BEFORE the write, the same guard
`InvoiceSettlementService.applyOnlinePayment` makes for every gateway and for
the same reason: a refusal leaves the invoice open and is recoverable, a posting
is not. The award still stands (a decision is not thrown away over a posting
problem) and the refusal logs at ERROR naming both currencies, because nothing
revisits a settled invoice. The REVERSAL needed no change — it reads its amount
off the credit payment row on the same invoice. Second defect on the same path:
the family was told "the award has been credited against the student's school
fees" whether or not anything posted; the message now follows the outcome, and
the audit row carries WHY nothing posted rather than only `disbursed: 0`. Program CRUD + review + award
all audited in the operator's own tenant. Verified: 8 scoping unit tests + the
`scholarship_application` RLS cross-tenant case (coverage gate green) + live
end-to-end (create→apply→consent-gate→submit→signals→cross-tenant review→award→
₦-credit on the invoice) + web production build (67 routes) + route smoke.

## ID-card QR scan — BUILT (`apps/api/src/certificate`)
Student/staff ID cards now carry a REAL scannable QR (pdfkit vector squares via
the `qrcode` lib) encoding the member's global `uniqueId` — replacing the old
decorative barcode. A tenant-scoped lookup resolves a scanned code to a member
of the SCANNER's OWN school for library / attendance / exam-hall / gate desks:
`GET /members/scan/:code` (`member.scan`, seeded to principal/school_admin/
junior_admin/head_teacher/teacher/librarian/warden/head_warden). SECURITY: runs
in `runAsTenant` so RLS confines it — a foreign `uniqueId` returns **404, not
403** (no cross-tenant existence disclosure); returns ROSTER-level fields only
(name/role/admission#/class/status), never medical/PII; every scan audited
(`member.scan`). Web desk at `/scan` (`ScanConsole` — always-focused input for a
handheld scanner + a purpose selector). The desk also RECORDS actions:
`POST /members/scan/:code {purpose}` writes an append-only `scan_event`
(rls/88, INSERT+SELECT only, migration `20261003000000`) — CHECK_IN of a
student ALSO marks them PRESENT in today's class register (a deliberate
central check-in that bypasses the per-class teacher restriction, `takenById`
= scanner); CHECK_OUT/LIBRARY/EXAM log the movement only. GET stays a pure
side-effect-free lookup. `member.scan` is a NEW permission: run the seed against a live
DB (or it 403s even for staff) — the runtime guard reads role→perms from the DB
(`role-permissions.service`, static `@sms/types` map is only the fallback).

## Grade reports — term-weighted + session-weighted (consistency pass, BUILT)
Both weightings share the pure grading policy in `@sms/types/grading`
(GRADE_COMPONENTS exam60/mid20/assn10/note10 = 100; `computeTermSubjectGrade`,
`averageOf`). `TermResultService` computes per-term `subjectResult` and the
cumulative `getStudentSessionReport` (each subject's per-term totals + session
average + overall session average). Downloadables: per-term scoresheet
(`.../:termId/pdf`) AND the new whole-session cumulative report
(`GET /term-results/report/:studentId/:sessionId/session-pdf`,
`generateSessionReportPdf`; web `SessionReportButton` on the ReportCard).
Accuracy fixes: **report-card ATTENDANCE and GRADES are now term-scoped** — the
attendance summary filters to the term's `session.date` window and grades filter
to `assessment.termId` (new nullable column, migration `20261004000000`; a new
assessment is stamped with the CURRENT term at creation; existing/untagged rows
read all-time — fail-open). UNIFIED: the OFFICIAL report card (`reportcards/`, persisted to the Document
Vault + guardian-notified) now renders the TERM-WEIGHTED subject grades from the
SAME `TermResultService.getStudentSessionReport` the scoresheet/broadsheet use
(no divergence) — subject table (exam/mid/assn/note/total/grade), term average +
overall grade + CLASS POSITION (competition rank of the student's term average
among classmates, PUBLISHED-only, no other pupil's marks shown), term-scoped
attendance, remarks, cumulative session average, branding. The gradebook
scoresheet (one term) + session PDF (cumulative) remain as lightweight
downloads off the same data. The old raw-LMS-submission report card is GONE. Workflow reactors are
type-isolated, so GRADE_PUBLISH and ATTENDANCE_AMENDMENT never interfere.

## Attendance register — write windows (BUILT)
Three tiers gate a register write (`AttendanceService.markAttendance`):
- **≤7 days old**: applied directly.
- **>7 days old (STALE), current term**: a plain teacher's edit raises an
  `ATTENDANCE_AMENDMENT` workflow (systemOnly; single-stage
  `ATTENDANCE_AMENDMENT_CHAIN`, perm `attendance.amend.review` held by
  head_teacher/school_admin/principal) — a DIFFERENT senior approves (SoD,
  engine-enforced) and a WorkflowHooks reactor applies the marks in-tx. Holders
  of `attendance.amend.review` edit stale registers DIRECTLY (they're the
  approvers). Scan CHECK_IN is always today → never stale.
- **Past/ended term**: fully LOCKED (409), no edit even with approval — boundary
  is the `isCurrent` term's startDate (fail-open when unconfigured);
  `GET /attendance/term-lock` exposes it. `STALE_REGISTER_DAYS = 7`.
`attendance.amend.review` is a NEW permission → re-run the seed on a live DB (the
guard reads role→perms from the DB).

## August 2026 correctness pass — what changed, and the rules behind it
Twenty-five fixes found by asking, of each control, "is it applied on every path
that does the thing?" The durable facts:

- **A REGISTER IS NOT A QUEUE.** `LIST_CAP = 500` says inbox views "only ever
  surface the most-recent page" — true of live work, false whenever the list is
  also the record a school reads LATER. Approvals (`GET /workflows`), the leave
  register (`GET /hr/leave/requests`) and assessments (`GET /assessments`) now
  take filters + `page` and return `{items,total,page,pageSize}` with the
  MATCHING total. Measured before: 702 workflow requests returned 500; 800 leave
  requests hid 300; 541 assessments hid 41 with no filter that could reach them.
  Filter in SQL — filtering in memory still only sees the recent rows. A search
  must AND onto the caller's scoping, never replace it. `mine=1` on approvals is
  narrowed in memory ON PURPOSE (it depends on a stage permission inside a JSON
  column) and is safe only because live work is bounded; history is paged in the
  database. A fee run's DRAFTs are finished with `POST /invoices/issue-bulk`
  (explicit ids, capped, partial success reported) — there was no batch way to
  issue a batch, so hostel rent stayed invisible.
- **ELEVATION REACHES THE UI.** `activeGrantPermissions` is the ONE definition of
  what a grant gives you, called by the guard AND by login/refresh; the session
  carries `elevated` and `sessionPermissions()` merges it. Before, a grant was
  honoured by the API and lit up no screen. The AppShell says when authority is
  borrowed. A workflow stage decided under a grant is recorded in the IMMUTABLE
  trail — the reviewer's comment no longer REPLACES the system's notes (`??`
  became a join), which is where that fact used to vanish.
- **"TODAY" IS THE SCHOOL'S DAY** — now also the transport boarding register
  (keyed on `(passenger,date,direction)`, so a wrong day OVERWRITES another
  journey) and the exam-day board's default. Six remaining `toISOString()` uses
  label a document; they do not key a record.
- **A CONTROL WITH ANOTHER WAY ROUND IT IS NOT A CONTROL.** The leaver
  document gate ran on `getDownloadUrl` and not on `streamFile` — the door the
  web actually uses. Both now call one `assertReleasable`, BEFORE the bytes are
  fetched. A RECEIPT is never gated: withholding personal data over a debt is
  unlawful rather than firm.
- **EXITED USERS CANNOT AUTHENTICATE.** `validateLogin`, `refreshClaims` and the
  password-reset path all refuse a non-ACTIVE user. This BOUNDS a whole class of
  "a leaver still has X" worries — check it before treating one as live. Staff
  may no longer REPLY to a pupil who has left (the thread stays readable, the
  office remains reachable); a class change deliberately does NOT end a
  conversation, because that moves it to WhatsApp.
- **MONEY MUST SAY WHERE IT WENT.** A library fine now lands on an ISSUED
  invoice (a DRAFT is not a bill: hidden from families, excluded from
  receivables — so an UNPAID fine was invisible and became visible only by being
  paid), records the METHOD it was paid by (the journal has a Method column and
  everything read CASH), bills the charge if it is missing rather than taking
  cash with nothing on the ledger, and tells the family at both ends.
- **REPORT WHAT YOU DID NOT DO.** The exeat sweep marked every overdue boarder
  as handled including the ones it could tell nobody about; it now marks only
  what it alerted, and alerts the FAMILY in their own words. An alumni broadcast
  reports `unreachable` (records with no linked account). The attendance rollup
  had no sweep at all — built, consumed by `useRollup`, and never populated;
  nightly now (`attendance.rollup` in the jobs catalogue), 452 ms -> 32 ms with
  IDENTICAL figures.
- **A SIGNAL IS NOT A PENALTY.** Scholarship signals report `disciplineUpheld`
  and `disciplineOpen` separately and NEVER a DISMISSED complaint. `discipline
  .file` is held by students, so the old single count let a classmate's
  accusation — and a complaint the school had rejected — count against a child
  asking for help with fees.

**Gates added, each validated by reintroducing the defect it exists for:**
`service-methods-nobody-calls` (a dead read is a query somebody can wire up in
one line; five removed, the sixth exempted with a reason),
`assertions-that-match-by-accident` (`not.toContain("5")` matched a digit in a
timestamp — made three times in this repo), `wire-shape-agrees` (`apiGet<T>`
ASSERTS the wire and never checks it; a paging change broke two pages with a
clean typecheck and 3,600 green tests). // GOTCHA: after ANY response-shape
change, grep the web consumers AND run `WEB_URL=http://localhost pnpm --filter
@sms/web smoke:routes` — the smoke is still the only thing that catches a
field-level break.

## Operating the live system — runbooks
- **`docs/RUNBOOK-INCIDENT-RESPONSE.md`** — the on-call playbook: severity
  levels, 5-minute triage, per-symptom playbooks (outage / latency / DB / Redis
  / bad deploy / payments / auth / **tenant-isolation breach** / data loss /
  security / scheduled jobs), rollback (incl. why a destructive migration makes
  rollback the WRONG move), recovery verification, and the blameless post-mortem
  template. Post-mortems land in `docs/postmortems/`.
- **`docs/RUNBOOK-BACKUP-RESTORE.md`** — backups, PITR, and the restore drill.
- GOTCHA the runbook encodes: **`/api/health` is the WEB tier's liveness probe**
  and answers 200 without touching the API or DB. The API's own `/health` is not
  internet-reachable (the ALB forwards only `/ws/*` to the API target group; REST
  flows web→api over Cloud Map). For a real end-to-end probe use a public
  API-backed read such as `/api/public/plan-pricing`.
- When a fix changes operational behaviour, update the runbook in the SAME PR —
  a runbook that lags reality is worse than none, because it is trusted.

## Demo fixtures are FAIL-CLOSED (never seed a demo account into production)
The seed runs on EVERY cloud deploy (the one-off `migrate` ECS task calls
`prisma db seed`), so anything unconditional in `seed.ts` lands in PRODUCTION.
It previously created the demo school, 17 `@demo.school` logins AND the platform
`super_admin` — all on the public password `password123`, which the login page
also printed. That is a full platform compromise for anyone who guesses the
convention.
- `SEED_DEMO_DATA=true` (default FALSE) is now required for ANY demo fixture:
  the demo school, its users and its content. Set it in `infrastructure/.env`
  for local compose; NEVER set it in cloud.
- Production still seeds what it genuinely needs: the platform org, the SYSTEM
  audit actor, and the role/permission registry — the last must keep re-running
  so new permissions reach a live DB.
- `owner@sms.platform` / `manager@sms.platform` exist in every environment but
  take their password from `PLATFORM_OWNER_PASSWORD`. Unset in a non-demo run ⇒
  created with an UNUSABLE hash (`!no-password-set`, which bcrypt can never
  match) plus a warning. Setting the env var and re-running the seed DOES
  rewrite the hash — that is the documented recovery path — while a run WITHOUT
  it never clobbers a password the owner has since changed.
- The login page carries NO demo-credentials block at all — not even an
  env-gated one, since a single mis-set variable would turn it back into a
  public principal account. Demo logins for local work are listed in this file
  and in `/help`; a sign-in page never prints working credentials.
**If a cloud DB was ever seeded before this change, those accounts still exist.**
Audit with `SELECT email FROM "user" WHERE email LIKE '%@demo.school' OR email
LIKE '%@sms.platform';` and rotate/disable anything with the old password.

## Owner-facing documents — the PRICING ACCURACY rule
Three assets quote commercial facts (plan tiers, commitment discounts, cycle
lengths, trial length, the maker-checker money threshold) to school owners. A
stale number here is not a cosmetic bug — a proposal quoting a discount you no
longer offer is a commitment a prospect will hold you to.
- `apps/web/app/for-owners/page.tsx` — the PUBLIC marketing page. **Derives**
  `CYCLE_DISCOUNT_PERCENT` and the `PLANS` count from `@sms/types`; never type a
  pricing number as prose here.
- `docs/ONBOARDING-MANUAL.html` — the leader's manual, served at `/manual`
  (signed-in only). Static HTML, so it cannot import constants.
- `docs/SCHOOL_OWNER_PROPOSAL.md` — the proposal sent to prospects. Same.
The two static documents are guarded by
`apps/web/lib/__tests__/pricing-consistency.test.ts`, which reads them from disk
and asserts they state the CURRENT values from `@sms/types` — so changing a
pricing constant without updating them fails `pnpm test` with the filename and
the fix. It also fails if the GENERATED `apps/web/app/manual/manual-html.ts` is
stale, since `/manual` would otherwise serve outdated pricing after the source
was corrected.
**After editing the manual, regenerate the served copy:**
`pnpm --filter @sms/web build:manual`.
Contact details (`support@majormaestro.com`, WhatsApp) appear in all three —
update together. Brand hierarchy: **MAESTRO-SMS** is the product,
**MajorGBN Innovations Limited** the company, **majormaestro.com** the support
desk shared across all MajorGBN products.

## When generating code
- Explain the multi-tenancy/security implication of each new table or endpoint.
- After scaffolding, output RLS SQL and migrations SEPARATELY for review before
  applying (RLS goes in `packages/db/prisma/rls/`, not Prisma migrations).
- Every new module follows the built pattern: tenant-scoped tables + non-null
  `school_id` + RLS, a service with relationship scoping (404 not 403), audited
  mutations, an RLS-e2e cross-tenant case, and a unit test for the scoping logic.
- Prefer small, reviewable commits over one giant change.