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