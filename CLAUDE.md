# CLAUDE.md — School Management System (SMS)

## What this is
A multi-tenant, enterprise School Management System serving up to ~50 schools
concurrently from one deployment. Each school (tenant) gets: an LMS for students,
monitoring dashboards for teachers, a parent monitoring dashboard, and a
BPMN-style approval engine. Security posture: least-privilege access control and
defense in depth throughout.

This file is durable project context — the CONTRACT a change is taken against.
Follow it on every task. If a request conflicts with it, flag the conflict before
proceeding.

**Where the rest lives.** This file holds the rules; the reasoning and the
evidence live beside it, and are worth opening rather than re-deriving:

| Document | What it answers |
|---|---|
| `docs/ENGINEERING-LOG.md` | **383 written-up fixes** — what was wrong, how it was measured, what was decided and why, and the `// GOTCHA` lines. Distilled into "Defect classes that keep recurring" below. **Grep it for a defect's shape before fixing one.** |
| `API.md` | Every route the API declares — GENERATED (`pnpm --filter @sms/api build:api-doc`), gated by `api-doc-is-current.spec.ts`. |
| `docs/RUNBOOK-INCIDENT-RESPONSE.md` | On-call: triage, per-symptom playbooks, rollback, the isolation/scope/permission probes. |
| `docs/RUNBOOK-BACKUP-RESTORE.md` | Backups, PITR and the verified restore drill. |
| `docs/ONBOARDING-MANUAL.html` | What the product PROMISES a school owner. Gated against the code by `what-the-help-page-promises.spec.ts`. |
| `DEAD_AND_WOUNDED_PLATFORM_SPEC.md` | The game platform's full spec — read it before any work on the game. |
| `docs/PRODUCTION_DEPLOYMENT.md`, `docs/SCHOOL_OWNER_PROPOSAL.md` | Deploying it; selling it. |

## Golden rules (non-negotiable)
1. EVERY tenant-scoped table has a non-null `school_id`. ONE named exception,
   `gateway_event`, because a verified webhook is RECORDED BEFORE its tenant is
   resolved from the event's own metadata; its RLS is written for that (INSERT
   with no GUC, tenant SELECT) and an unresolved row is invisible until
   resolution fills the column in. The rule is enforced, not merely stated:
   `rls.e2e-spec` fails on any OTHER nullable `schoolId`, and requires that one
   to still exist so the carve-out cannot go stale. A new nullable `schoolId` is
   not an exception to add — every RLS policy reads
   `schoolId = current_setting(...)`, and `NULL = anything` is NULL rather than
   TRUE, so such a row is invisible to every tenant: written, acknowledged and
   readable by nobody.
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
- **A SUBJECT IS OWNED BY ITS TEACHER; THE ROOM IS NOT.** `teachesClass` is the
  UNION (supervise ∪ teach-a-subject) and answers "may I see this class" —
  **`teachesSubjectInClass` is the narrow one** and decides who may plan,
  publish, schedule or grade a subject. Untagged is the deliberate hole: a form
  tutor addresses the whole room. The READING half mirrors it — a pupil sees
  only the subjects they OFFER, failing OPEN where a school has no approved
  selections, and every screen SAYS when it failed open, because "you take them
  all" and "nobody has approved your choices" looked identical.
  // GOTCHA: **COUNT THE DOORS — there were SIX and two were guarded**, on
  // WRITE (create/update/clone/copy-to-arms for content, create/update for a
  // live class) and two more on READ (`join`, `playRecording`, which took an id
  // and asked only about CLASS enrolment, so hiding a lesson left the link
  // working). `a-subject-rule-written-once` asks about SPELLING and passed over
  // a door in the very file it vouches for; `every-door-that-tags-a-subject`
  // COMPUTES the writer set from source. `mayUseSubject` is the predicate,
  // `assertMayUseSubject` the throwing form, `assertOffersSubject` the by-id
  // refusal (404) — one rule, three shapes, because the per-arm copy must SKIP
  // with a reason rather than abort halfway.
  // GOTCHA: **the server half was INERT for as long as it existed** — the
  // scheduling form never sent a `subjectId`, so every live class was untagged
  // and reached the whole class whatever the rule said.
  // `a-field-no-screen-can-fill-in` cannot catch this (the name is on dozens of
  // screens); only DRIVING the form does. The picker offers the caller's OWN
  // subjects — an option the server refuses is a form that fails on Save rather
  // than a control that is absent.
  // GOTCHA: a spec here PASSED throughout while its double answered a query
  // selecting `classId` with rows shaped `{ subjectId }`, so `classIdsTaughtBy`
  // collected `[undefined]`: false in the test, true in production.
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
  // GOTCHA: that last clause was ASPIRATIONAL for as long as it had been
  // written. `createInvoice` read `input.currency ?? "NGN"`, so a school with
  // its fee currency explicitly set still had every bill it raised denominated
  // in naira — measured on a US school with `currency = 'USD'`. The library,
  // hostel and transport paths all resolved `school.currency`; the one a bursar
  // uses to bill TUITION was the one left. Fixed and gated by
  // `a-bill-in-the-schools-own-money.spec.ts`, which reads all four writers.
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
  for a currency with no operator `plan_price` row, and had drifted to half the
  live prices — opening a new currency would have quoted half price.
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
- **PRICING IS ANCHORED ON THE SESSION; THE TERM IS DERIVED.** A school buys a
  TERM or a SESSION, nothing else. NGN is ₦4,016.25/5,737.50/7,458.75/9,562.50
  per seat per session. `plan_price.perSeatSessionMinor` is the ONE stored
  number per (tier, currency); term =
  `session / (1 - SESSION_DISCOUNT_PERCENT) / termsInSession(school)`, so the 15%
  is a consequence of the division rather than a figure anyone keeps true.
  // GOTCHA: **a session is NOT three terms for every school** — TWO_SEMESTER is
  2 (US, Canada), FOUR_QUARTER is 4. Pricing a session as three terms makes the
  advertised 15% a 27% PENALTY for one and a 36% giveaway for the other.
  `termsInSession` is REQUIRED with no default: a default of 3 compiles
  everywhere and is wrong in two countries.
  // The monthly atom is GONE. `perSeatDailyMinor` survives for proration and
  arrears only, never displayed, rated from the cycle the school is ON.
  `CYCLE_MONTHS` is CALENDAR DURATION now, never a price multiplier. The PUBLIC
  list is one currency (every tier, ENTERPRISE included); what a school is
  CHARGED in comes from its own region at checkout. Gate:
  `a-price-in-a-unit-nobody-buys` (15% across every tier x currency x TEMPLATE).
- **THE TAKE-RATE IS ON**: `platform_fee_config` id `'fees'` (a SINGLETON — a row
  with any other id is invisible to `PlatformFeeService`, which cost me a probe
  to discover), 150bp capped at ₦2,000, borne by the PARENT.
- **Self-serve BILLING ENGINE — BUILT** (`apps/api/src/billing`, `apps/web/.../billing`):
  turns the entitlement gate into recurring revenue. A school's principal/
  school_admin self-checks-out a tier (`@RequireStepUp`) at `/billing`; pricing is
  **per-seat** (active students × the cycle's per-seat price — pure
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
Eight monetization levers on the billing/gateway rails. (1) **Fee-collection
TAKE-RATE** — operator-set convenience fee (flat+bp+cap, ZERO fail-safe default)
via the Paystack split's `transaction_charge`; global `platform_fee_config`
(rls/71), per-school bearer choice (`school.paymentFeeBearer`), webhook credits
the ledger with the INVOICE amount only (`payment.platformFeeMinor` records the
cut). (2) **Admission-form fees** — `school.admissionFormFeeMinor` snapshot per
application, public checkout at intake, webhook stamps `formFeePaidAt`
idempotently. (3) **Saved-card AUTO-RENEW** — reusable Paystack authorization
field-encrypted on `school_subscription`; dunning charges ~2 days pre-lapse at
CURRENT seats (<=1 attempt/20h). (4) **Proration + TRUE-UP** —
`platform_subscription_payment.kind` (RENEWAL extends / UPGRADE restarts, unused
time credited / TRUEUP updates seats only, never `priceMinor`). (5) **Promos +
AGENTS** — global `promo_code` (percent off FIRST charge) + `agent`/
`agent_commission` (rls/72, ledger DENY-ALL to the app role, unique schoolId =
once-only). (6) **MESSAGE CREDITS** — append-only `message_credit_entry` (rls/73);
each SMS/WHATSAPP delivery debits 1 ONLY after the gateway CONFIRMS, gated by a
per-job ALLOWANCE from `balanceInTx` so two metered channels cannot both spend the
last credit; empty balance fails those channels soft. Operator oversight at
`/operator/message-credits`. (7) **GROUP console** (MODULES.GROUP) — global
`school_group` registry (rls/74 deny-all); DIRECTORSHIP is the authorization,
`/group` renders cross-campus aggregates, never PII. (8) **CBT exam hall**
(MODULES.CBT) — banks -> questions (answerIndex SERVER-ONLY until a sitting
closes) -> timed exams -> sittings (clock is server law, auto-marks are
staff-reviewed numbers, Golden Rule #8); rls/75. Migrations 20260829–20260905,
RLS 71–75, an RLS-e2e case for every new tenant table.

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
  (`ESSENTIAL_NOTIFICATION_TYPES` — the billing/platform types plus
  DISCIPLINE_OUTCOME and ATTENDANCE_ABSENCE, each added later with its reason
  beside it) ignore per-type mute but still respect channel toggles. Read the
  constant, not this sentence — which has now rotted TWICE: it once listed the
  billing types as if they were all of them, written before the two that matter
  most to a family were added; and it then said "six" of them while one was
  `ADMIN_APPOINTMENT`, a WORKFLOW type no notification has ever carried, so the
  true figure was five. The count is gone; the constant is typed against
  `NOTIFICATION_TYPES`, so it can no longer name a notification that does not
  exist. NO preference row = deliver all (historical default). `/account` card.
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
HR roadmap (15 items) is COMPLETE — the per-item build log is in
`docs/ENGINEERING-LOG.md` and git history; what a change is taken against is:
- **Money and pay are maker-checker throughout.** A salary change is
  request-then-approve by a DIFFERENT person (both step-up); `upsertEmployee`
  cannot touch salary at all (create-only); payroll FINALIZE has its own second
  signature (creator ≠ finalizer). Old and new salaries are field-encrypted.
- **Payslips are SNAPSHOTS** (`breakdownEnc`), never recomputed, so history
  never moves when a tax pack changes.
- **`hr.self` gates self-service** (`/hr/me*`, leave, appraisal acknowledge) —
  it used to overload `workflow.create`, which is every staff member.
- **Leave rides the staged workflow**; the finalized hook is idempotent and
  PENDING-only, and decrements the year's balance in-tx.
- **Staff NDPR erasure clears the self-service fields and RETAINS the statutory
  employment and payroll record** — the two obligations point opposite ways.
- Lifecycle, reviews, recruitment and analytics follow the standard module
  pattern (tenant tables + RLS file + cross-tenant case + audited mutations).
  `RecruitmentService.convert` maps the GLOBAL `user.email` unique violation to
  a 409, because the RLS-scoped pre-check only ever sees the same school.
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

## Defect classes that keep recurring
Distilled from **383 written-up fixes in `docs/ENGINEERING-LOG.md`** — the case
law behind every rule below, with the measurement, the alternatives rejected and
the `// GOTCHA` lines. **Grep the log for a defect's SHAPE before fixing it**:
most defects here are the second or third instance of a class already recorded.
These are the rules; the log is why each one exists.

### The two that account for most of them
1. **SIBLING ASYMMETRY — the careful half is written first and the other is
   left.** Somebody reasons a rule out, writes it down in a comment, fixes the
   file in front of them, and does not sweep. Found dozens of times: a payroll
   bank export that asked the currency beside a statutory CSV that did not; a
   cohost checked three ways and the host not at all; `/help` corrected for the
   lockout while the manual kept the old sentence; five spellings of one staff
   set, four right. **When you fix one, sweep its siblings IN THE SAME COMMIT,
   and prefer one shared definition to a sixth correct copy.** A control written
   six times is right five times.
2. **A GUARD ON ONE DOOR IS NOT A GUARD.** Two write paths, one checked. A
   boundary schema and a service that both validate, and only one was tightened.
   A rule enforced in the module it was written in is not enforced. Drive EVERY
   door by direct id rather than reading the call graph — that is what found two
   open marking routes after a fix claimed to cover "all three".
   **COUNT THE DOORS.** Class capacity had SEVEN writers, enforced at four —
   `/classes/:id/enrollments` refused a full class while `/admin/import/students`
   and admissions filled it in silence. One `assertClassCapacity`, and a gate
   COMPUTING the writer set from source. // GOTCHA: **a pre-check in an EARLIER
   transaction is a snapshot, not a reservation** — re-assert inside the WRITE.

### Truth-telling
- **A count or claim typed into prose ROTS.** Role counts, RLS-file counts,
  README TODOs, an exemption's reason, `API.md`'s own headline. The durable fix
  is a **documentation gate that reads the constant**, not a fresher number:
  `claims-in-claude-md`, `pricing-consistency`, `runbook-freshness`,
  `what-the-help-page-promises`, `api-doc-is-current`.
- **A comment asserting agreement is not agreement.** Two files each carried
  "same rule as the report card" while disagreeing with it and each other — and
  `ClassAttendanceBoard` warned that `/classes/<id>` is not a route while three
  other files linked to it.
- **A CATEGORY NOBODY EMITS IS A FILTER THAT ANSWERS NOTHING, AND A SWITCH THAT
  GOVERNS NOTHING.** `NotificationInput.type` was `NotificationTypeValue |
  string`, so the union gated nothing and four hand-kept lists grew beside it.
  FIVE strings named notifications that do not exist. Measured: 67% of a
  parent's 3,320 notifications were unreachable through any menu option, and
  four of eight mute checkboxes did nothing. **A control that appears to work
  and does not is worse than one that is missing**, because the reader stops
  looking for the real switch. The fix is the type system, not a fresher list:
  the union is enforced at every emitter and `NOTIFICATION_TYPE_LABELS` is a
  `Record<union, string>`, so an unreachable category is a compile error. Gate:
  `every-notification-type-can-be-found`. // GOTCHA: a gate asking "is this type
  emitted?" must scan only NOTIFICATION call sites — the first version searched
  all source and passed a mutation, because the same string was a WORKFLOW type
  in the same file. That confusion IS the defect.
- **A COUNTER MUST COUNT WHAT WAS DELIVERED, NOT WHAT WAS ITERATED.** The fee
  reminder counted per INVOICE whether or not a guardian existed: 30 invoices,
  no guardian links, "30 reminded", nobody told. Count recipients.
- **REPORT WHAT YOU DID NOT DO.** Silent partial success is the commonest shape
  here: a sweep marking every overdue boarder handled including those it told
  nobody about; `notified: 2500` of 5,000. Count what was WRITTEN.
- **A refusal must not assert something untrue, and should name the way out.**
  "Not in this school" said of a classmate; "ask an administrator to reactivate
  it" where no such button exists. **404-not-403** so a refusal never confirms
  what it hides — and the inverse: it must not DENY what the product has already
  shown on screen.

### Money
- **Never sum across currencies**; return a currency with every total. A `_sum`
  cannot express a REFUND's sign — `netPaidOf` is the one definition of "paid".
- **Scale by the CURRENCY, never by 100** (`formatMoney` / `minorFrom`); 11 of
  29 catalogued currencies are zero-decimal. Gate:
  `money-is-not-divided-by-a-hundred`.
- **A SHARED HELPER CALLED WITH ITS DEFAULT IS STILL A PLATFORM-CURRENCY SITE.**
  `money(amountMinor, currency = PLATFORM_REGION.currency)` — so `money(x)` is
  the bug written with the *correct* helper, the spelling that survived after
  every hand-rolled `₦${…}` was swept. `school-currency` scans `app/(app)` PAGES
  as well as `components/` (it did neither for server pages, where two live
  defects sat beside fixed siblings) and flags a bare `money(x)` unless shadowed
  by `useFormat()`. **A DTO that reports money must say what currency it is in.**
- **A gateway is ALWAYS told the currency**, and settlement REFUSES a mismatch
  before posting. One posting path (`InvoiceSettlementService`), so one guard.
- **A naira constant is not a rule for every school**, and the two fail-safes
  point OPPOSITE ways: an unset **control** tightens (every payment reviewed), an
  unset **charge** goes to zero (a charge that guesses bills a family).
- **There is no FX rate in this platform.** Refuse and say so; never convert.

### Time
- **"Today" is the SCHOOL's calendar day** (`schoolToday(tz)`), not the server's
  UTC day — registers, term locks, clock-ins, overdue states, expiry stages.
  Fifteen surfaces have been corrected for this.
- **A `@db.Date` is a DAY, not an instant** — midnight UTC, so a zone west of UTC
  shows the PREVIOUS day (`isCalendarDate`).
- **Validate a date by ROUND TRIP** (`isoDay`): JS ROLLS rather than refusing, so
  `2026-04-31` parses cleanly as 1 May — a shape check is not enough.

### Lists, queues and scale
- **A DIARY IS THE MIRROR OF A REGISTER, AND AN ASCENDING CAP EATS THE FUTURE.**
  A register is read oldest-first; a diary is read for what is NEXT. Meetings had
  `mySlots`/`myBookings` on `startsAt ASC` capped with NO date filter: a
  school-wide reader got 200 rows spanning **a single day three years earlier**
  and zero upcoming. Order so the cap keeps what the screen is FOR.
  // GOTCHA: `listOpenSlots` one method away filtered `startsAt >= now`, with a
  comment about this exact failure, and was never swept to the other two.
- **A capped list is worse when it is the only route to something else.** The
  billing history was the 50 most recent with no page, and a payment's id
  appears NOWHERE else, so its receipt went too. Ask what a dropped row was the
  key to.
- **"Live work is bounded" is an assumption, not a fact.** The approvals queue
  read the newest 500 PENDING rows and narrowed in memory — but live work is
  bounded by what the school never got round to DECIDING, and that grows: at
  three years, 666 pending, a reported total of 500, the 166 OLDEST unreachable
  at any page. Scan oldest-first on the one shared predicate; report a floor as
  a floor.
- **AN OVERDUE ROW IS AN OLD ROW**, so a newest-first cap discards what the
  screen is alarming about: 300 recent loans under a strip counting 1,316
  overdue, 14 reachable at ANY url. When a page shows a COUNT, the list beside it
  must produce those rows — as a FILTER, oldest-first.
- **WHEN A LIST IS CAPPED, ASK WHETHER THE CONTROL THE READER USES REACHES PAST
  IT.** The library searched in the browser over 200 of 1,800 titles; `/exams`
  filtered 200 of 540 locally. **Each time the server could already answer and
  the screen never asked** — `/exams` had accepted `q`, `hall`, `from`, `to` and
  `scheduleId` all along. A count is half the fix; the filter running in SQL is
  the other.
- **A PICKER IS THE ONLY ROUTE TO THE THING IT NAMES.** `/discipline/file-targets`
  returned the first 500 by name, no search, no count: on a 1,200-pupil roll
  that was A to K, so **690 pupils could not be named in a complaint at all**.
  Search inside the SCOPED set and return a total.
- **A TOTAL MUST COUNT ONLY WHAT THE CALLER MAY READ.** A capped list's count
  and search inherit the list's own scoping: the notice board is
  audience-filtered, so `count` and `q` carry the same filter — 501 for the
  principal, 400 for the parent. **Widening the REACH must never widen the
  RULE.**
- **A JUMP-TO BOX IS STILL A CAP.** The omnibox showed six per category with no
  count, so *not on the roll* and *one of the 144 I did not show* read alike.
  Return `shown`/`total`, order by a TOTAL order, and count only when the
  `PER_CATEGORY + 1`-th row proves more.
- **AND THE FILTER A TOTAL IS COMPUTED OVER CAN ITSELF BE TRUNCATED.** The
  operator revenue screen aggregated in SQL over the whole filter — while that
  filter was the first 500 name-matching schools: at 800 it reported NGN
  262,500,000 of 420,000,000.
- **A FIGURE COMPUTED FROM A CAPPED PAGE IS WORSE THAN A SHORT LIST.** The
  scholarship panel derived headlines from its fetched `take: 500` array:
  leadership saw **500 / 405 / 29** against a true **1,200 / 980 / 60**. A short
  list looks like a list; a wrong number looks like a fact.
- **A PREDICATE MATERIALISED AS IDS IS SENT TWICE.** "Every customer school"
  spelled out as a 5,000-element `ARRAY[…]` is a 195 KB statement at 2x the cost
  of the subquery, and the PLANNING half grows with the fleet (`operator-fleet`).
- **A CAP WITH NO COUNT IS THE COMMONEST DEFECT IN THIS REPO** — a scan of every
  `findMany` with a literal `take` and no `skip` found **65**. When you cap,
  return the TOTAL; a newest-first cap eats the record.
- **A MAKER-CHECKER QUEUE IS MONEY IN LIMBO, WORKED OLDEST-FIRST.**
  `listPendingPayments` was `createdAt DESC, take: 200` with no count, and a
  payment there has NOT moved the balance: at a 901 backlog **78% of the money
  awaiting a second signature was invisible**. Nor is it small by default — the
  threshold resolver returns 0 off the platform's currency.
- **A register is not a queue.** A capped newest-first list DROPS the oldest —
  the row a review queue exists to surface. Page and count **in SQL**; filtering
  in memory only sees rows that survived the cap. Never narrow a count by the
  filter.
- **A ROW THAT CAN CONTRIBUTE NOTHING MUST NOT OCCUPY A SLOT.** With no lower
  bound on recurring events, 600 dead series filled a 500 cap and each expanded
  to zero: **a blank calendar**. Filter on what makes a row USEFUL
  (`recurrenceUntil >= from`), and fetch one PAST the cap to detect truncation.
- **No silent truncation.** An export is complete or says it is short, and every
  row must be IDENTIFIABLE — the NDPR bundle returned 36 payslips as
  `{gross, net}` with no period, date or run: complete, and unreadable.
- **Measure as the APP ROLE under RLS, with a BOUND PARAMETER, on volume, with a
  realistic distribution.** All four have produced a wrong answer: `postgres`
  bypasses RLS and plans differently; a literal picks an index a pooled app will
  not get; a dev-sized table picks the other plan; one pupil holding every
  invoice measures nothing.
- **O(lifetime), not O(size)** is the shape that degrades invisibly — it tracks
  how long a school, or a PUPIL, has been here. `/grades/mine` returned every
  mark ever, unpaged: 2,430 rows / 831 KB for a parent of three, to see this
  week's work. Bound it to the period the SCREEN claims; keep the rest reachable.
- **ALUMNI ONLY EVER GROW**: a newest-first cap loses the OLDEST cohort, which
  is backwards for the one list whose value is its age.
- **Offset paging needs a TOTAL order.** `gradedAt` alone is not one: 239
  distinct rows of 270 across six pages. Add `id`. The test passed until the
  double SHUFFLED before sorting — `Array.sort` is stable in V8, Postgres is
  not. And **an index nothing selects is write amplification** — one added here
  by reasoning was chosen NEVER, because **an ordering column behind a
  NON-EQUALITY predicate is unreachable for ORDER BY** (`status IN (a,b)`
  cannot be walked in `lastRemindedAt` order). Put the predicate in a PARTIAL
  index and the ordering columns come to the front: 26.9ms Seq Scan + heapsort
  -> 2.5ms Index Scan, the sort GONE. Prove an index dead by DROPPING THE OTHER
  inside a transaction that ROLLS BACK — with both present the planner's choice
  says nothing about the loser.
- **THE ROW IS THE ROUTE.** The CBT console returned the 100 newest of 1,350
  exams — and an exam row is the only route to its RESULTS, PAPER, ANSWER KEY
  and grade RECORDING, so a cap strands four surfaces, not one.
- **Count in the database**; never `findMany().length`. Never a query per row —
  `.map(r => this.toDto(tx, r))` is a query multiplier, and so is a name lookup
  in a loop (open duels was N+1 twice: 200 round trips for 100 lobbies).
- **A TENANT-LEADING INDEX SERVES EVERY READ AND NO FOREIGN-KEY CHECK.**
  `(schoolId, studentId)` is right for every scoped read, and an FK check gets a
  bare `studentId` with no tenant to lead with, so it seq-scans — 73 of the 79
  FKs into `user`. Harmless until somebody purges a tenant: index the
  referencing columns, delete, drop them again.

### Authorization and tenancy
- **A permission has TWO halves**: the route gate says whether you may read at
  all, the service's wide-role set says whose. They drift — a grant whose row
  scope refuses it is dead, and renders as an empty screen rather than a 403.
- **`super_admin` holds no standing role scope over a tenant's data.** The
  supported route to it is impersonation: step-up gated, time limited, audited.
- **Work and approvals go only to somebody STILL HERE** (`assertStillHere`/`holdersOf`) — addressing a leaver is addressing nobody.
- **A stage-holder must open its own door**, and an approver must SEE what the
  decision turns on. Both have their own gates.
- **A chain resolved at SUBMIT goes stale when somebody LEAVES.** Admissions
  drops an unstaffable stage at submit and refuses an approval that would strand
  the rest — both look FORWARD, and neither reaches the approver who exits while
  the item waits. Measured: 252 of 5,000 schools' applications sat at a stage
  with no ACTIVE holder, undecidable in BOTH directions. There is no reassign,
  so SAY it — on the row, in a count no filter can hide, and in the refusal.
- **Never trust an id from the body.** Check the KIND (a pupil made a subject
  teacher, a guardian attached to staff), not merely that it exists. "MAY I reach
  this pupil" is not "IS this a pupil of ours", and for a school-wide caller the
  first returns without touching the database: the Vault stored a report card
  against ANOTHER SCHOOL's pupil on a 201. Check with the shared scope
  (`EVER_ENROLLED_STUDENT`, `NOT_A_STUDENT`) — ever-enrolled, since a school owes
  a leaver their records. **Order the checks so the refusals cannot differ.** An
  id naming nothing is a **400 (P2003 in `MalformedIdFilter`)**, not a 500.
- **Read-then-write at READ COMMITTED is not a guard.** Prefer a UNIQUE INDEX
  where the rule is expressible, an advisory lock where it is not — and the guard
  and the race must answer with the SAME status.

### Completeness of a change
- **A control the product imposes must have a way to FINISH it** — and a way OUT.
  A maker-checker raised on a tier whose decide route was module-gated; a
  recurring charge with no cancel; a model with a create and no update (**64**,
  one holding an answer key); an open duel only a TEACHER could close, which its
  own host could not even see.
- **A ROUTE GATE MUST BE DEFAULT-DENY, NOT A LIST OF WHAT TO PROTECT.**
  `middleware.ts` held a hand-kept `PROTECTED_PREFIXES` and the app outgrew it:
  eight sections answered **200 with no session**. That gate is THREE controls —
  the /login redirect, the 30-day forced reset and the MFA mandate — so a user
  with an expired password could open the exam hall and a child's report cards.
  No data escaped (the page streams its shell, then throws on `session!.user`) —
  a gap, not a leak. Inverted to a PUBLIC allowlist in `lib/public-routes.ts`;
  gate `every-signed-in-page-needs-a-session` walks the router. // GOTCHA: Next
  serves `app/icon.png` through the same matcher, so default-deny must exempt
  ASSETS. // GOTCHA: the rule lives in its OWN module so the test drives the REAL
  function — the first draft reimplemented it and disagreed about `/icon.png`.
- **A LINK TO A PAGE THAT IS NOT THERE** — the inverse of the rule below.
  `/attendance`'s "take →" pointed at `/classes/<id>`, not a route. Gate
  `a-link-to-a-page-that-is-not-there` matches every literal href against the
  declared routes; it found a fourth on its first run.
- **A PICKER MUST REMEMBER WHAT WAS PICKED.** The choice was re-derived from
  `[...seed, ...results]`; choosing clears the query, which clears `results`, so
  anybody found by SEARCH vanished on being chosen. Hold it in state.
- **SCROLL IS PART OF THE CONTROL, BOTH WAYS.** Next scrolls to the top on every
  push, hiding the history the attendance pupil-picker asked for
  (`{ scroll: false }`) — and its MIRROR: /attendance's Take-register button
  links to the URL you are ALREADY on, so it navigated nowhere, made zero
  requests and left the form 1,094px below the fold. Reveal the section yourself.
- **A ROUTE NO SCREEN CALLS IS A DOOR MISSING FROM THE OUTSIDE.** `GET
  /members/scan/today` was reached from nowhere — one level out from the gate
  that catches a service method no CONTROLLER reaches.
- **A SUMMARY MUST NOT NARROW WITH THE FILTER BELOW IT.** The desk's day counts
  are a `groupBy` over the whole day, independent of `?purpose=` and the page.
- **A field the API accepts that no screen sends** is a feature nobody has
  (`a-field-no-screen-can-fill-in`); **a method no controller reaches** shipped
  with no door (`service-methods-nobody-calls`); **a page nothing links to** is
  not delivered (`every-page-can-be-reached`).
- **A duty given with a notice is taken away with one**; retract only what was SENT.
- **Fixing where it hurts and leaving the siblings is how the class survives.**

### Tests, gates and probes
- **Mutation-validate every gate**, compile-time ones included: break the fix,
  watch it fail *naming the right thing*. Gates have passed for the wrong reason
  repeatedly — a fixed-size source window spanning two methods, a same-named
  method vouching for dead code, `not.toContain("5")` matching a digit in a
  timestamp, an assertion satisfied by the COMMENT explaining its own fix (strip
  comments), an `as` cast defeating a `Record<Key,true>` check, and a detector
  matching only LITERALS while the needle was a variable.
- **`Tests: 0 total` is not a pass**, and a mutation that does not COMPILE — or
  that changes no behaviour — proves nothing. Read `Test Suites:` as well as
  `Tests:`; a jest pattern passed where a FLAG belongs matches nothing.
- **A gate that walks must assert it scanned something**: no files, no offenders.
- **A test on a helper proves nothing about its caller** — drive the real thing.
- **A 200 WITH NO BODY IS NOT JSON.** Nest sends a handler's `null` as a
  zero-byte 200, so `res.json()` THROWS — and in an effect the throw lands
  mid-way, so the state set after it never happens: the register form drew no
  pupils and no Save button for every class not yet marked. `apiGet` had the
  rule server-side; `lib/read-json.ts` is the client half. A fixture that
  already holds the row makes it impossible and reports success.
- **A NUMBER ASSERTED OVER A WHOLE DOCUMENT IS A LOTTERY.** `not.toMatch(/\b33\b/)`
  over a report-card PDF fails ~3.3% of runs on its "Generated … HH:MM:SS" line,
  and the POSITIVE form passes with the cell wrong whenever the clock reads
  `:29:`. Read the CELL, and fake `Date` only (pdfkit needs real timers).
- **Anchor a test to the PROPERTY, not the text** (nor a column's POSITION) —
  fixed-text assertions have gone red ten times on changes that STRENGTHENED what
  they guard. **And never prove an ABSENCE by searching a serialised document**:
  a uuid containing the secret ("…925d-**31234**1a1dd8c") failed CI on a test
  whose property held. Walk the parsed object and compare VALUES.
- **An over-wide gate is the same failure as a blind one** — an exemption granted
  for a false positive is a hole with a note on it. Delete the rule instead.
- **FIXTURE TRAPS, over and over:** a stub whose `findMany` ignores the `where`
  (or `take`/`orderBy`) passes against a service that stopped filtering; one
  missing a method every real client has (`createMany`, `groupBy`, `$queryRaw`,
  `text()`) fails in a way that reads as a code fault; one returning the live
  object a later `update` mutates makes an audit read the NEW value; and
  `$executeRaw` is a TAGGED TEMPLATE, so `q.values` is `Array.prototype.values`.
  **A double must model the CONTRACT, not the signature** — including that a
  `null` handler arrives as an EMPTY body.
- **A probe that guesses a field name reports a fact about itself.** Read the
  STATUS before the body; scope a probe's queries to the tenant under test; and
  prove the session took — 401 everywhere reads as "refused" for every route.
- **Drive it, do not read it** — and where a SCREEN is the report, drive the
  screen: the register form's real defect was a parse in the browser, invisible
  to every API-level check, and the tell was an absence (no POST ever sent).

### Operational safety
- **Fail closed at BOOT** where a mis-set value is unrecoverable afterwards
  (encryption key, auth secret, storage provider, public URL, email sender,
  `API_BASE_URL`). An env var set to an EMPTY STRING is not unset; `??` is blind
  to it.
  // GOTCHA: **"boot" means the process EXITS.** Two weaker versions of this
  check were built first and neither failed closed. A throw in the ACCESSOR is
  caught by the caller's own try/catch — `/schools` answered **200** with
  "refresh in a moment" and no log line naming the cause. A throw in
  `instrumentation.ts` is caught by Next, which prints `Failed to prepare
  server`, then prints `✓ Ready`, and serves. Only `process.exit(1)` fails the
  deploy. Verify against `node .next/standalone/…/server.js`, not `next start`,
  which refuses `output: standalone`; keep the check LAZY, since `next build`
  runs with `NODE_ENV=production` and the variable is legitimately absent then.
- **A secret's SHAPE is not its PROVENANCE** — a well-formed key published in this
  repo is compromised for ever (`PUBLISHED_SECRETS`). Never seed a demo account
  into production (`SEED_DEMO_DATA`, fail-closed).
- **One school's failure must not end the fleet's sweep.** Catch per school, NAME
  it, and COUNT it into the result the operator console reads.
- **Probe hygiene:** never overwrite a real user's password (mint a token);
  scope every cleanup by id or timestamp; check what the container is RUNNING
  before believing a live result; `git checkout` on an uncommitted file discards
  the FIX, not the mutation.

## Every redirect is checked against OUR domains, not against a shape
`lib/safe-redirect.ts` is the ONE rule: a same-origin path passes, an absolute
URL passes only if its host is ours (`PUBLIC_WEB_URL` / `REDIRECT_ALLOWED_HOSTS`;
`*.domain` covers subdomains, never a bare `endsWith`), anything else becomes
the fallback, and an unconfigured deployment owns nothing. `?next=` is the only
visitor-controlled target; gateway callbacks are built from `publicWebUrl()`.
// GOTCHA: **a browser normalises `\` to `/`**, so the obvious guard
// (`startsWith("/") && !startsWith("//")`) shipped an OPEN REDIRECT on the
// SIGN-IN page — measured live, `/\evil.com` and `/%5Cevil.com` were emitted as
// `Location`. Written THREE times, every copy carrying the flaw: a copied check
// is right zero times. Refuse control characters rather than trimming (browsers
// STRIP them), decode once, and note `PUBLIC_WEB_URL` is server-only.

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
- **A FAILED `migrate deploy` LOCKS THE WHOLE HISTORY**, and the tempting repair
  diverges the schema: `resolve --applied` on every unrecorded folder clears the
  error and lies — six of nine were genuinely ABSENT on the test DB, i.e. a clean
  history over missing schema, the `plan_price` failure again. RECIPE: verify the
  FAILED one's objects are ALL present (table, indexes AND constraints),
  `resolve --applied` just that one, `migrate deploy`, then **`pnpm --filter
  @sms/db rls`** — migrations bring TABLES, policies are separate, and a GLOBAL
  table landing with RLS off is invisible to the coverage meta-test, which keys
  on tables that HAVE a `schoolId`.
- RLS files use bare `CREATE POLICY` (Postgres has no IF NOT EXISTS for it), so
  they are order-sensitive, not idempotent — the entrypoint applies them per-file
  against a sentinel. `02_foundation_rls.sql` is the ONE exception: its two
  `audit_log` policies DROP-then-CREATE, because `20260824000000_audit_log_
  partition` re-declares those same names. Without that, 02 aborted partway on
  any migrate-deploy DB and silently left the rest of the file unapplied.
- New tenant table: add `prisma/rls/NN_*.sql` and a cross-tenant case to
  `apps/api/test/rls.e2e-spec.ts` (and its afterAll cleanup, child rows BEFORE
  parents — FK order matters). Register the file in
  `apps/api/docker-entrypoint.sh` (`apply_rls <file> <last-policy-name>`): the
  entrypoint applies RLS per-file idempotently, keyed on each file's LAST policy
  as a sentinel, so a new file lands on an initialised DB without re-running the
  others. Do NOT hand-edit `TenantTx` — it is `Prisma.TransactionClient`.
- Integrity retention: telemetry on minors (integrity_signal / submission_draft /
  submission_telemetry) is purged past `School.integrityRetentionDays` by a
  privileged daily sweep + `POST /integrity/retention/run`
  (`integrity.retention.run`). The app role has NO DELETE there; the purge uses
  `DATABASE_RETENTION_URL` (falls back to `DATABASE_MIGRATE_URL`); unset →
  retention DISABLED. See `apps/api/src/integrity/retention`, `prisma/rls/06_*`.
- Tests: **`pnpm --filter @sms/api test:db` runs ALL of it.** A bare `jest`
  SKIPS every DB-gated suite (the RLS e2e among them) because each
  `describe.skip`s without `TEST_DATABASE_URL`, so **a green local run says
  nothing about a quarter of the suite**. It now SAYS SO: `a-green-run-that-
  skipped-a-quarter-of-itself.spec.ts` prints the count and the command on every
  bare invocation, and DERIVES the count rather than restating it — the figures
  that used to be written here ("3,619 tests, 28 suites, 396 tests, CI runs
  4,015") had all rotted by the time I read them, which is what a number typed
  into prose does. As measured today: bare runs 4,433 and skips 427 across 33
  gated suites; `test:db` runs 4,858 in 460 suites, all passing — CI sat red for three days (0 of 71 runs after 17 Aug
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
- **The full API suite needs `--maxWorkers` capped on a developer machine, and
  the right number depends on what else is resident.** Jest defaults to
  `cpus - 1`, each worker with its own ~2.2 GB V8 heap ceiling — on an
  8-core/15 GB box that is 7 workers against a ~15 GB peak. At the default it is
  killed at STARTUP before writing a line, which reads as a hang rather than an
  OOM; `--maxWorkers=3` survived a quiet machine (508 s, FASTER than the 865 s
  default run, because the workers stop contending) and was killed at suite 294
  of 612 when a browser was also open; `--maxWorkers=2` completed. Do not run a
  web build or a second suite beside it.
  // GOTCHA: **a worker killed for memory presents as a TEST failure.** The run
  // reports `FAIL <suite> ● Test suite failed to run — A jest worker process
  // was terminated by another process: signal=SIGTERM`, naming a suite that
  // never executed and has nothing wrong with it. Read the message before
  // chasing the named file: re-running that suite alone is what tells them
  // apart. CI sizes its own runner, so this is a local constraint, not a repo
  // one.
- **Fake timers must be CLEARED, not just switched off.** `jest.useRealTimers()`
  alone left the worker holding a handle, so jest force-exited it — and only
  when ANOTHER file ran after it in the same worker, which is why it was
  intermittent and invisible under `--runInBand`. Reproduced minimally:
  `tenant-cache.spec` plus `audit-cursor.spec` warned, either alone did not, and
  disabling `useFakeTimers` stopped it. Both sites now `jest.clearAllTimers()`
  first. // GOTCHA: `--detectOpenHandles` cannot diagnose this — on the full
  suite it OOMs the Node heap under its implied serial run (the trap this file
  already records), and on a subset it serialises enough that the warning
  disappears and it reports no handles at all. Bisecting by file is what found
  it. A residual warning still appears on the whole suite under parallel
  workers with no handle reported; it exits 0 and everything passes, but the
  same condition one step further is what HANGS the CI test step, so it is
  worth chasing rather than muting with `forceExit`.
- EVERY DB-gated e2e suite must `await prisma.$disconnect()` (the `@sms/db`
  singleton) in `afterAll`, even if it only touched the DB via a service — an
  undisconnected pool keeps the jest worker alive and HANGS the CI test step
  indefinitely. `--runInBand` locally masks it (another suite's disconnect in
  the shared process closes it for everyone), so a suite can look fine locally
  and still hang CI. Cleanup ordering: `audit_log` rows reference users
  (`audit_log_actorId_fkey`), so delete them BEFORE the suite's `"user"` rows.
- Seed permission registry: `seed.ts` upserts the UNION of its hand-listed `PERMS`
  and every key `ROLE_PERMISSIONS` references (`ALL_PERMS`), so a permission added
  to the role map cannot crash the seed or silently miss the DB. A LIVE DB gets
  new permissions only when the seed RE-RUNS (compose seeds on first provision
  only) — otherwise the new endpoint 403s even for super_admin.
- Raw SQL in tests supplies `updatedAt` (Prisma `@updatedAt` has no DB default)
  and quotes `"user"` (reserved word).
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

BUILT (spec §11 steps 1–8) — **the per-step detail is in the SPEC, which this
file tells you to open; what follows is only what a change is taken against.**
- **Where each mode lives**: pure scoring `packages/game-engine/scoring.ts`
  (length is a PARAMETER, N=4/5/6); in-memory transport `apps/game-server`;
  durable modes in `apps/api/src/game` — duel `game.service`, league/knockout
  `competition.service` (+ pure `game-engine/competition.ts`), class race
  `race.service`, elimination ring `ring.service`, per-school config
  `game-settings.service`, cross-school arena `ultimate.service`. RLS 18–21;
  race/ring add columns only and reuse the `game` policies.
- **Server authority is absolute.** Secrets are server-only, never serialized,
  cleared on finish; scoring, turn order, finish order and win detection are
  computed server-side; every secret and guess is re-validated (N distinct
  digits). A racer sees only their OWN guesses; a ring cracker inherits the
  eliminated player's history via `eliminatedById` and nobody else does.
- **Ring and race own their lifecycles** and do NOT route through GameService;
  league matches DO (its `finish` hooks `afterMatchFinished`, one-way, no cycle).
- **`effectiveGameSettings`** merges the school's row over platform defaults and
  is what gates opening a game and supplies difficulty, race rate-limit, ring
  turn limit and league window — consulted via a tx helper, not the constructor.
- **The Ultimate arena is the one deliberate tenant crossing**, in two opposite
  halves: an RLS-EXEMPT cross-school arena carrying NO PII (handle, school NAME,
  scores — nothing else crosses), and TENANT-SCOPED governance
  (`UltimateEnrollment` school opt-in, `UltimateConsent` guardian consent,
  `UltimateEntryLink` the ONLY userId↔participantId map). Entry needs BOTH
  consent tiers AND the school's `crossSchoolEnabled`.
- **Permissions**: `game.play` / `game.leaderboard.read` broadly;
  `game.league.create`, `game.race.open` (teacher own-class), `game.race.tournament`,
  `game.match.moderate`, `game.settings.manage` (school_admin ONLY — principal is
  operations, not configuration), `game.ultimate.admin` (super_admin,
  NON_ELEVATABLE) / `.enroll` / `.consent`. Every mutation, consent change and
  arena entry is audited.

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
— a SNAPSHOT OF THAT DATE.** migrate deploy, every RLS file clean under
`ON_ERROR_STOP=1`, seed, the whole api suite, game-engine, typecheck and a web
production build. Every COUNT it carried has since rotted, which is what a number
typed into prose does; what keeps coverage honest is the GATE, not this
paragraph: `rls.e2e-spec.ts` introspects `pg_class` for every table carrying a
`schoolId` and fails if one lacks a cross-tenant case, so the set under test is
COMPUTED. `ultimate_participant` is still the one documented exemption.
// GOTCHA from that run: a winner's cracking guess NECESSARILY equals the secret
and legitimately shows in the move log, so `not.toContain(secret)` over the whole
view was wrong — assert the UN-cracked secret never leaks and the stored column
is cleared. And those DB suites `describe.skip` without `TEST_DATABASE_URL` +
`TEST_ADMIN_URL`, so they had never once executed before it.
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

## ID-card QR scan + certificate reprints — BUILT (`apps/api/src/certificate`)
**A REPRINT REPRINTS — it does not mint a second certificate.** A plain reprint
(no title/body, what `ClassIssuer` sends) reuses the registered certificate AND
its serial, audited as `certificate.reprint`; a title or body means a DIFFERENT
award and gets its own. It renders the REGISTERED words, serial and ISSUE DATE —
not the request, which on a reprint is empty, and not today's date on last
year's testimonial. `certificateId` names WHICH one and is checked against the
subject and type; a plain reprint of a type held SEVERAL times REFUSES and names
them, and every history row has a **Reprint** control so the refusal is a fork
rather than a dead end. ONE `certificateSerial()`, and `serial` is UNIQUE
(migration `20260907000000`) so a collision is a 409, not two cards that verify
as one. The full write-up — three rounds of this, each a half-fix — is in the
engineering log.
**A serial nobody can check is not a verification.** Every certificate prints
"may be verified … by quoting the serial number", and for a long time no route,
method or screen accepted one. `GET /certificates/verify/:serial` does:
`runAsTenant` so RLS confines it, another school's serial 404s **in the same
words** as an unknown one, audited because it names a pupil. Web: **Check a
certificate** on `/certificates`.
ID cards carry a REAL scannable QR (pdfkit vector squares, `qrcode`) encoding the
member's global `uniqueId`. `GET /members/scan/:code` (`member.scan`, seeded to
principal/school_admin/junior_admin/head_teacher/teacher/librarian/warden/
head_warden) resolves it within the SCANNER's OWN school: `runAsTenant`, a
foreign `uniqueId` is **404 not 403**, ROSTER-level fields only (name/role/
admission#/class/status) and never medical/PII, every scan audited. Web desk at
`/scan`. `POST /members/scan/:code {purpose}` writes an append-only `scan_event`
(rls/88, INSERT+SELECT only, migration `20261003000000`) — CHECK_IN of a student
ALSO marks them PRESENT in today's register (a deliberate central check-in that
bypasses the per-class teacher restriction, `takenById` = scanner);
CHECK_OUT/LIBRARY/EXAM log the movement only. GET stays side-effect-free.
`member.scan` is a NEW permission: re-run the seed on a live DB or it 403s even
for staff — the guard reads role→perms from the DB.

## The report card is a GRIDDED FORM, not a flowing document
Laid out from a real Continuous Assessment Report: every section is a bordered
box under a titled bar, A4 portrait at 28pt margins. Order is
letterhead → personal data | attendance + terminal duration → rating key →
skills → grade key → academic performance → remarks + attestation. **The RATING
KEY precedes the ratings and the GRADE KEY precedes the marks** — both used to
sit below the thing they explain. The annual block is not a section: it is the
ANNUAL SUMMARY half of the marks table, carrying the session's OTHER terms
(the current term's figures are already under MARKS OBTAINED).
// GOTCHA: a table cell wants `lineBreak: false` so a mark that no longer fits
ellipsizes rather than reflowing the row; a cell holding a SENTENCE wants the
opposite and silently truncates to its first line. `cellText` takes `wrap`.
// GOTCHA: the reference's letterhead says "Continuous Assessment Report"
because that is what THAT school calls it. The card says **"Report Card"** —
copying a layout must not rename everyone else's document.
// **RENDER IT AND LOOK.** Two defects were invisible in the text extraction and
obvious in a PNG (`pdftoppm -r 110 -png`): a label row over an empty attendance
box, and "all 1 terms". Text assertions do not see layout.
// Prior-term column widths are DERIVED from what is left, so a three-term
school's "Second Term" fits and a four-quarter school's ellipsize visibly.
// **Component marks print AS THEY COUNT** (`effectiveComponents`), because the
total is a sum of CLAMPED components and printing the raw ones gave a row that
did not add up. All THREE printers use it — card, term scoresheet, session
report. It preserves null, so "not marked" stays distinct from "scored zero".

## Analytics: every card obeys the period the page states
`/analytics` is headed "figures for {term} ... so these agree with the
term-scoped report card". The period was built for ATTENDANCE and never
extended — the grade aggregate counted every PUBLISHED grade ever and the fee
CTE had NO date filter, so the term picker moved one card of three. Measured on
the demo school: attendance 25,200 / 57,600 / 63,000 / 0 across its four terms
while avg grade read 68 and fees 12,885,000 for all of them. Grades now filter
on the ASSESSMENT's term exactly as the report card does and FAIL OPEN on an
untagged one (so a school mid-migration sees historic work in every term — the
stated cost, and the same answer the report card gives); fees window on
`COALESCE("issuedAt","createdAt")`, the day the school billed. // GOTCHA: a
BACKTICK inside a `Prisma.sql` template terminates the literal — a SQL comment
naming a column in backticks is a syntax error pointing at the wrong line.

## Busy is not broken — a full connection pool answers 503, not 500
Every tenant-scoped read opens a transaction (`runAsTenant` sets the RLS GUC in
one), so a full pool raises Prisma **P2028** (P2024 for a plain query), and both
fell through to 500 "Internal server error". Driving 1,500 schools' analytics at
30-way concurrency failed **1,358 of 1,500**. The work is fine — a 1,200-pupil
school renders in ~250ms alone and 32-way concurrency over small schools fails
none; it is a few LARGE tenants that empty the pool (30 at once failed 24 of 40).
Default pool is `cpus x 2 + 1` with no `connection_limit` set. Now 503 +
`Retry-After: 5` saying nothing was changed and to retry, logged at WARN — a real
fault is still a loud 500. **Set `?connection_limit=` explicitly in deployment**
against the instance's CPUs and RDS `max_connections`.

## A total is AGGREGATED, never summed off a fetched page
`/operator/analytics` read the most recent 5,000 payment rows and summed them in
Node. The bound was deliberate — an unbounded fetch grows with the platform's
lifetime — and applied to the wrong half: bound what crosses the WIRE, not what
is COUNTED. Because the window is newest-first, old payments fell out as new
ones arrived, so a card labelled **"Revenue · all time"** went DOWN over time.
Measured at 6,508 payments: NGN 5,000,000 shown against NGN 30,846,756.64 true,
**83.8% missing**, nothing saying a row was dropped; crossed in year four at 500
schools. The same array fed the monthly revenue trend, so a growth chart erased
its own history. Both are SQL aggregates now; analytics got FASTER (267 -> 227ms).
// GOTCHA: `revenue.payments` was the length of that capped ALL-CURRENCY array
while the money was home-currency only — a count and a total describing different
populations under one heading. // GOTCHA: the spec's `$queryRaw` double filtered
currency ITSELF, so dropping `AND currency = …` passed the mutation. A double
must honour the query's own predicate.

## Correcting a school's region — where it lives, and what follows
`/operator/tenants` (or the directory) -> a school -> **Profile & region** ->
`PUT /operator/tenants/:id/region`, `platform.tenants.region` + step-up. The
editor states **Currently set to** before offering the change, because an
operator is usually there to CORRECT a mis-onboarding. // GOTCHA: it could not
show one for as long as it existed — `SchoolProfileDto` carried no `country`
and the page cast for it (`as unknown as`), so a Ghanaian school read as
"platform default (Nigeria)". A cast is how a missing DTO field becomes a
silent `undefined` instead of a compile error. // GOTCHA: **a corrected country
does not carry the year's SHAPE with it.** `calendarTemplate` is stamped from
the country at provisioning and is a stored column, so a school onboarded as US
(TWO_SEMESTER) and corrected to Nigeria kept two semesters in a three-term
country. It now realigns ONLY when the stored value equals the OLD country's
default (derived); one that differs was CHOSEN — the documented escape hatch —
and survives. Audited as `calendarTemplateRealignedTo`. // GOTCHA: an explicit
`timezone`/`currency`/`complianceRegime` override BEATS the country and a
country change does not clear it; the confirm dialog says which values are
pinned rather than promising a move that will not happen, and each override has
a clear control (an empty string clears to null).

## An archive is taken OF a session, and says which
`POST /privacy/archives` takes `{label, sessionId?, termId?}` and it is the ID
that bounds the export (`windowFor` -> a date range every dated section is
filtered by). **The label bounds nothing.** The panel sent a typed label and no
id, so every hand-taken archive was a whole-school dump wearing one year's name:
measured, 99 MB vs 82.5 MB scoped and 41,213 audit rows vs 3,341, from years
either side of the label. The screen now PICKS from the school's own sessions
and terms (newest first; an undated year is offered but disabled with the
reason; the whole-school export stays, explicitly). // GOTCHA: the list could
not tell a bounded archive from an unbounded one — `ArchiveSummary` carries the
resolved window now, and a row with none says "all years". // GOTCHA:
`a-field-no-screen-can-fill-in` cannot catch this class when the field name is
common across the web (`sessionId` is on dozens of screens); it asks only
whether the web MENTIONS it.

## Races: fit the remedy to the RULE, and distrust a green probe
Six money paths were read-then-write at READ COMMITTED and each needed a
DIFFERENT remedy — that is the durable part; the measurements are in the log.
- **Uniqueness** -> a UNIQUE INDEX. `attemptQuiz` counted then inserted (two
  attempts on a one-attempt quiz, both numbered 1); one signed webhook replayed
  concurrently posted SIX payments. Convert P2002 to the guard's own 409, or the
  index only trades a double-post for a retry loop — a non-2xx makes a rail retry.
- **A balance invariant** -> an ADVISORY LOCK, because an append-only ledger has
  no row to lock. One pupil's credit applied to two invoices at once finished at
  -5,000,000. The CURRENCY belongs in the key: a pupil can hold two balances.
- **Read-modify-write on a row** -> `SELECT ... FOR UPDATE`, taken by EVERY
  writer that reads an invoice's money and then writes it. Settlement did not,
  so its safety was borrowed from whichever other writer held the lock — and two
  gateway payments have no such neighbour.
- **A DEFERRED write** -> a RESERVATION, not just a lock. Metered sends debit
  only after the gateway confirms, so two jobs each read a balance neither had
  spent; the budget is the balance MINUS in-flight (`attempts` stamped pre-send).
// GOTCHA: **fixing the lost update is not fixing the race.** `decideAdjustment`
// had a race-safe DECREMENT with a comment explaining it, while the CAP two
// lines above still read a stale balance. Read a concurrency comment as a claim
// about WHAT IT COVERS.
// GOTCHA: **money AWAITING APPROVAL is already committed against the invoice** —
// the overpayment guard counted POSTED only, so two payments each for the full
// balance both passed. Sequential, through the front door: not a race at all.
// GOTCHA: **distrust a green race probe until you have made it go RED.** Eight
// concurrent HTTP requests did not reproduce the quiz race (interleave the
// statements instead), and a settlement probe passed 6/6 until the neighbouring
// lock was removed. Adding a guard then breaks every double that modelled
// yesterday's collaborators — that failure is the signal the guard landed.

## An error message is the SERVER's reason; a hint is only a fallback
A status usually has several causes and the component knows one. Eleven did
`res.status === 403 ? "<claim>" : await readApiError(res)` — measured on
`payments/:id/approve`, which 403s both for separation of duties AND for a
missing permission, so someone lacking `fee.approve` was told they had recorded
a payment they had never seen. Pass the hint to `readApiError(res, hint)`
instead: it is used ONLY when the server gave nothing specific. Forty other
sites fell back to `Failed (403).`; they route through `interpretApiError` now,
which also stops appending its generic clause to a specific message (it can
contradict it) and treats Nest's default phrases ("Forbidden", "Bad Request") as
no detail. Gate: `an-error-message-that-is-true`. // GOTCHA: its first version
flagged every status-conditional literal and caught nine LEGITIMATE 404 hints on
scoped reads, where the hint is the right reading of 404-not-403 and the server
says nothing. Narrowed rather than exempted.

## Money AWAITING APPROVAL is money committed against the invoice
The overpayment guard read POSTED payments only, so two payments each for the
FULL outstanding balance both passed — neither could see the other — and
approving both paid the invoice twice. **Not a race**: sequential, through the
front door; the `FOR UPDATE` lock was irrelevant because both legitimately
passed a check that ignored what was queued. Measured: a 15,000,000 invoice with
5,000,000 posted took two payments of 10,000,000, finishing at **25,000,000
posted, balance −10,000,000, status PAID**. `pendingApprovalMinor` was on the
DTO and on the screen the whole time; it was not in the guard.
TWO guards: record-time counts pending (and NAMES it in the refusal), and
approval RE-CHECKS because an online payment can settle while one waits.
Refunds are bounded by `paid + min(0, pending)`, closing the same hole.
// GOTCHA on ORDER: the re-check goes AFTER the optimistic claim — before it,
the loser of two people approving the same payment was told the invoice was
full, which is true of the balance and the wrong answer to their question. A
throw after the claim rolls it back with the transaction.
// GOTCHA on doubles: a `payment.findMany` stub that ignores `where.status`
reports POSTED rows as pending; and a `runAsTenant` double must MODEL ROLLBACK
or "nothing is half-applied" cannot be tested.

## Timetable generate: "already scheduled" is not "could not be scheduled"
`generate` respects existing entries and seeds its busy-sets from them, so a
re-run over a FINISHED grid reported every lesson as UNPLACED with "the class
already has a lesson in every slot" — what an OVER-ALLOCATED school sees.
Quotas are now discounted by what is already on the grid and reported as
`alreadyPlaced` (only when NOT replacing — `replace` deletes those rows first).
// GOTCHA, and the route that makes it routine: **generate is synchronous and
scales with the school.** A 60-class secondary (2,400 lessons) takes ~110 s;
nginx's `location /` had NO `proxy_read_timeout`, so the 60 s default returned a
raw **504** while the server finished and wrote all 2,400 lessons — and the
operator, told it failed, pressed again. Raised to 300 s (now 201 in 84.5 s).
**In the cloud an ALB and CloudFront have their own idle timeouts; raising nginx
alone is not enough there.**

## An inbox orders by LAST ACTIVITY, and seeks on the column it orders by
`reply` bumps `messageThread.updatedAt` on every message; `listThreads` ordered
by `createdAt` and read it for nothing, so a conversation never moved. Measured
on a teacher with 400 threads: a parent replied at 06:15 and that thread sat at
**position 400** while page 1 showed older activity. Now `updatedAt DESC, id
DESC` with `seekWhereOn`/`toPageOn` cutting the cursor on the SAME column, plus
the matching index (migration `20260909000000`). // GOTCHA: a cursor cut on a
different column than the ordering does not mis-sort, it SKIPS whole runs of
rows. // GOTCHA: paging on a MUTABLE key can show a bumped row twice or miss it
— the accepted cost of a recency-ordered inbox, and far better than a message
from today at position 400. `POST /messages/threads` takes `recipientId`, SINGULAR.

## A gate whose SET is hand-kept only guards what somebody remembered
`a-sweep-that-was-behind-and-said-nothing` checked a HAND-KEPT array of four
filenames, while the gate beside it computed its set by walking the BullMQ
processors and said so in a comment. Three capped MONEY sweeps were therefore
never checked: the overdue fee reminder (5,001 overdue invoices, 2,000 taken,
**no `orderBy` at all**, so the same 2,000 plausibly every week), the late-fee
sweep, and mobile-money recovery — where every stranded intent is a payer
already DEBITED while their invoice stays open. The set is computed now, from
the processors, following ONE HOP into the services a swept method calls
(`test/support/sweep-services.ts`, shared with the sibling gate).
// GOTCHA: **a warning is not a signal.** Two of the three already logged on
// hitting their cap and still returned a summary `JobRunsService` read as
// clean, so the console showed an ordinary line while a school fell further
// behind nightly. A count nobody surfaces is a count nobody acts on.
// GOTCHA: the gate's own `methodBody` took the first `{` after the method
// name, which for `): Promise<{ reminded: number … }> {` is the RETURN TYPE —
// the capped read was invisible because the gate was reading a type.

## A capped sweep must report its BACKLOG, not just what it took
Every scheduled sweep bounds its read, deliberately, and each reported only what
it TOOK — so a run that cleared its 500 and left 100,000 behind read exactly like
one that emptied the queue. Measured at 3,500 schools after a queue outage
stranded 21,918 deliveries: three hourly runs each returned `scanned=500
requeued=500 failed=0`, every console signal green, 21,858 families still
waiting. **`backlog` is a FOURTH fact**: not `failed` (tried and could not), not
`skipped` (not due), not `unreachable` (about the data) — DUE work queued behind
a cap. Every capped sweep reports it, counting with the SAME predicate its page
uses, named once so they cannot drift. `JobRunsService` reads it like `failed`
(opt-in, null = no notion of one) and the console shows a **Behind** badge; a
real `failed` outranks it. Gate: `a-sweep-that-was-behind-and-said-nothing`.
// GOTCHA: adding one `count()` broke six existing doubles — each must now count
the SAME set its `findMany` draws from, or it passes against a service computing
the backlog from the wrong predicate.
// **AND A CAP ONLY ADVANCES IF TAKING A ROW REMOVES IT FROM THE PREDICATE THE
PAGE IS DRAWN FROM.** The declined-applicant purge paged over APPLICATIONS and
wrote only to `document_submission`, so the same 500 matched every night for
ever: run 1 cleared 409 files, runs 2-4 cleared NONE, 191 birth certificates
held permanently while `backlog` sat frozen at 475,036 — which reads as
"behind", never as "stuck". Page the WORK, count the backlog on that predicate.
// **WHERE THE ROW CANNOT LEAVE, MARK IT** — an unpaid invoice stays overdue, so
the fee reminder's oldest-first cap chased the SAME 2,000 families weekly and
the 100 newest arrears never, and ordering by due date is what made that
certain rather than merely likely. Order by what the sweep CHANGES
(`lastRemindedAt`, NULLS FIRST), and never mark work nobody was told about.
// Both hid behind doubles ignoring `take`/`orderBy`; the backlog GATE went
blind on the first fix because `hasLiteralTake` knew `take:` and not `LIMIT`.

## PURGING A TENANT: index the referencing columns first
The 73 unindexed FKs into `user` are harmless until somebody hard-deletes a
tenant's users, then every delete seq-scans each of them: a 1,500-school fixture
ran **25 min without committing**. The remedy works as written — 23 temporary
indexes on the referencing columns in **1.2 s**, the delete then committing
**1,370,900 rows in 3 m 6 s**, indexes dropped after. Do this before offboarding
a real school.

## Background jobs: a sweep that skipped a school must SAY so
`JobRunsService.failedCount` reads a **`failed`** field off each job's stored
summary, and the operator's jobs console renders it as `lastFailed`. **A
cross-tenant sweep that catches PER SCHOOL does not throw**, so `lastOk` stays
true and every other signal is clean — a run that skipped four schools looks
exactly like a run that did the fleet. Ten sweeps were missing it; they all
count now, and `a-sweep-that-skipped-a-school-and-said-nothing.spec.ts` walks
every BullMQ processor, resolves the service it drives, and fails on one that
catches-and-logs without incrementing a `failed` counter.
// The convention is NARROW: `failed` is work this run could not do. It is not
`skipped` (work that was not due) — two sweeps folded a failure into that and
hid it inside a number that reads as normal — nor an `unreachable` (a fact
about the data). A processor must also RETURN the count: `record()` files
whatever the callback gives it, and one job dropped `failed` between the
service and the processor.
// **A MANUAL TRIGGER MUST MATCH THE PERMISSION THAT GATES IT.** The exeat
route was gated on per-school `hostel.manage` and ran the FLEET sweep: at 500
schools one registrar's press alerted 499 other schools' guardians and consumed
their pending alerts, in 12.6 s. Manual triggers are either scoped to the
caller's school (this one now is) or gated on a platform permission, the way
dunning and reconciliation are. Check the job catalogue's declared `scope`
against what the handler actually does.
// **AND WHEN THAT CHECK WAS FINALLY RUN PROPERLY, FOUR MORE WERE THERE.**
Reading each declared `scope` against the roles that actually HOLD its
permission found the archive sweep, the breach-deadline clock and the
declined-applicant purge (principal + school_admin) and the stranded-delivery
sweep (`notification.send` — every TEACHER), all running the fleet. Measured:
one demo principal's press wrote 500 permanent archives into 500 OTHER schools,
3,500 -> 4,000. `a-fleet-sweep-one-school-could-fire.spec.ts` reads the
catalogue as DATA and the role map and now fails on the next one.
// A third scope, **CALLER**, names what these are: the fleet for a platform
operator, the caller's own school for anyone else. Its route admits EITHER
permission (`@RequirePermission` already means "any one opens the route") —
without that the operator was 403'd on their own console's button, because
these asked for a permission only a school role holds and there is no
super_admin permission bypass.
// **A CATALOGUE NOTHING TYPE-CHECKS IS PROSE.** `SCHEDULED_JOBS` was a bare
`as const`, so two entries carried a manual trigger with NO `scope` at all and
the console's whole scope split silently did not apply to them. Declared
`ScheduledJob` and applied it with `satisfies` (which keeps the literal key
types `JobKey` is built from).
// **AND `where` IS A CLAIM.** Six jobs named the page their control lived on
and had no button there — including one that matched only because the page
reads `integrity/retention/run`**s**, the run HISTORY. There is one shared
`SweepButton` now, and `run-now.spec` walks the web tree and fails on a
school-pressable job nothing POSTs to. Match the WHOLE path: `includes()` let
`.../runX` vouch for `.../run`.
// GOTCHA: those buttons sit on SERVER components, so every prop must be
SERIALISABLE. A `describe={(r) => …}` typechecked, built, and passed 5,963
tests, then threw `Functions cannot be passed directly to Client Components` at
SSR — five pages rendering their loading shell and nothing else. Keep the
wording inside the client module so the TYPE is the gate.

## Promotion: a pupil returning to a class is not "already there"
`@@unique([classId, studentId])` means ONE enrolment row per pupil per class,
whose status is the latest state — so a pupil sent back to a class they have
been in before must have that row REACTIVATED, never skipped and never
duplicated. `enrollInto` skipped anyone holding any row for the destination,
which is right for an ACTIVE one and wrong for a CLOSED one — and a closed one
is the normal shape of a DEMOTION, because demoting means sending a pupil back
to the class they came from. Measured over five simulated years: the pupil ended
with no ACTIVE enrolment anywhere, off every register and out of the seat count,
and the roll read 119 of 120 with nothing saying where the other went. A
reactivation also takes a place, so it counts against the destination's
capacity.
// GOTCHA: the same method returns students LANDED, not rows written. That is
right — someone already ACTIVE there still ends the batch in it — but it was
true of everyone only once the reactivation existed; before that the count said
a demoted pupil had landed somewhere they had not.

## CBT grades and the publish order — an operational rule
**Record CBT grades BEFORE publishing the term, never after.** Writing a mark
onto a PUBLISHED `subject_result` reverts it to DRAFT by design (the change must
go back through the two-person chain), so `POST /cbt/exams/:id/record-grades`
run after a publish takes that subject off every family's card until it is
re-approved. Not silent — the response carries `revertedFromPublished` and both
`CbtStaffPanel` and `LmsGradebook` say "now back in draft and off report cards
until re-approved" — but the ORDER is the thing an operator needs.
// The CBT score is scaled to the SCHOOL's exam component, not the platform's
(`record-grades` reports `examMax`), and it REPLACES a hand-entered exam mark.
// GOTCHA for anyone driving it: the start response keys the sitting
`sittingId`, not `id`; a candidate's view serialises `answerIndex: null`; and
publishing an exam is SINGLE-stage `CBT_EXAM_PUBLISH` (one workflow.review
holder who is not the requester), not the head→principal gradesheet chain.

## Report-card ATTESTATION + public verification QR — BUILT
(`apps/api/src/reportcards/report-card-attestation.*`, `public-attestation.controller.ts`,
`report_card_attestation`, migration `20270115000000`, rls/112, web
`/verify/card/[slug]/[code]`.) **This platform captures no signature** — no
image, no certificate, nothing in `SchoolBranding` but a logo and three brand
numbers. A printed card has a ruled line signed by hand, and the VAULT copy a
guardian downloads carried it permanently blank: the digital card was the one
nobody had signed. A stored signature IMAGE was rejected deliberately — it is a
forgeable credential, a signature stamp in an unlocked drawer, and proves
nothing an attestation does not.
The card now carries a named approver (from `report_card_remark.headId`, with
`headRemarkAt` added so the date is when the head SIGNED and not whenever the
row last changed), the date, a 12-character code and a QR. Printed ONLY when
somebody has signed: no head remark, no block — a block asserting an approval
that did not happen is the failure this exists to prevent.
// GOTCHA: **the public route takes NO cross-tenant read.** The URL carries the
school's SLUG, so the school is resolved from the RLS-exempt registry first and
the lookup then runs under that school's GUC — an unauthenticated verifier is
confined by exactly the policy a member of staff is. A privileged client on an
internet-facing route would have given a public endpoint more reach than the app
role has (Golden Rule #4). ONE 404 for unknown school, unknown code and
right-code-wrong-school alike.
// GOTCHA: `contentHash` is what decides a new ISSUE, and it must be stable
under things that are not the document — it sorts subjects, because query order
is not part of a card, or every reprint would tell every holder theirs was
superseded. It DOES move on a changed grade at an unchanged total, because a
scale change re-letters a mark and that is a different document to anyone
reading the letter. Live: reprint unchanged -> Issue 1; one mark moved -> Issue 2.
// The verification page shows the MARKS on purpose: catching a doctored card
needs a comparison a human can make, a digest cannot be recomputed by eye, and
the reader already holds the card. Rate-limited, audited to `SYSTEM_ACTOR_ID`
(the caller is unauthenticated by design; inventing an identity would make the
trail say something untrue), and exported in the NDPR bundle as
`cardAttestations` — a named person's approval of a named child's marks is held
about that child.

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

## The register nobody took — a daily reminder, and a board that names WHO
`RegisterReminderService` (`attendance.registerReminder` in the jobs catalogue)
tells each class teacher, once, that their register is still outstanding.
Nothing did this before: the only attendance notification the platform sent went
to GUARDIANS about a child already marked absent, and the teacher who had marked
NOBODY heard nothing — which matters because an unrecorded absence is
indistinguishable from a pupil who was present, and past `STALE_REGISTER_DAYS`
the correction needs a second member of staff to approve it.
// GOTCHA: **NOT EVERY SCHOOL WEEK IS MONDAY TO FRIDAY.** The reminder hard-coded
a Saturday/Sunday weekend, which gets BOTH ends wrong in Egypt and Saudi Arabia
(both in the catalogue), where the week runs Sunday to Thursday: a register
missed on a SUNDAY would never be chased, and every teacher would be nagged on
their FRIDAY off. `CountryProfile.schoolDays` is the week, as data — a new
country is a row, never a branch — and `isSchoolDay` reads it. Verified live on
one Friday: the Cairo school reported NON_SCHOOL_DAY while the Lagos school was
chased normally.
// The reminder HOUR is per school too (`school.registerReminderHour`, migration
`20270204000000`, nullable so nothing moves for a school already live; the
control is on the register board behind `rbac.manage` + step-up, privileged
write like every other `school` registry setting). An out-of-range stored value
is IGNORED rather than obeyed — a stored 25 would mean a school silently never
reminded, which is the failure this sweep exists to make visible.
// GOTCHA: **a daily reminder needs an HOURLY sweep.** A fleet spans timezones,
so there is no single instant that is mid-afternoon everywhere — the same moment
is 14:00 in Lagos and 09:00 in Toronto. It runs hourly and acts on a school only
when THAT school's local clock reads `REGISTER_REMINDER_LOCAL_HOUR` (14), so
each school is reminded once in its own afternoon and 23 of the 24 ticks
correctly do nothing. `skipped` is therefore a large, healthy number here.
// It does not nag: weekends and days outside the term are skipped, a class with
nobody on roll is not an outstanding register, and a teacher gets ONE message
listing all their classes rather than one per class.
// `notified` counts TEACHERS TOLD, not registers walked; `unreachable` counts
outstanding registers whose class has no ACTIVE supervisor — nobody can be
reminded about those. The board says so (`teacherActive: false`), because
"nobody is assigned" is a different problem from "the teacher forgot".
// GOTCHA, and the reason `reminderOffReason` is ONE shared function: a school
that never set a CURRENT TERM is skipped every day for ever, and the only trace
was a `skipped` count in an operator console the school never opens — the board
looked exactly like one whose teachers were reminded daily. It states it now, and
sharing the predicate gave the sweep HOLIDAY awareness it never had (it would
have chased every teacher on a mid-term break).
// GOTCHA in the same shape: the button reported "Every register has been taken
today" whenever nothing was outstanding — INCLUDING when the sweep had not
looked. `skipped > 0` now says so.
// **WHO MAY TAKE A REGISTER IS ONE FUNCTION** (`canTakeRegister`): the class's
NAMED supervisor, plus `school_admin` as cover. It was written TWICE — the
enforcement and the by-class board's `canTake` — while the outstanding board had
no such field and drew a "take" button for everybody. The principal HOLDS
`attendance.write` and is refused at row scope, so the form rendered, they marked
the class, and Save 403'd: a dead grant showing as a form that fails rather than a
control that is absent. The form is built from the server's takeable list now, and
the heading follows what the reader can DO.
// **The rule is RESPONSIBILITY, not rank** — verified: a principal is 403 on a
class they do not supervise and **201 the moment they are named its supervisor**,
so a teaching head needs no exception. Two reasons not to widen it: principals
hold `attendance.amend.review`, so authoring would make the approver of a
correction its author; and a register attests "I looked at this room" — a gap that
is VISIBLE is safer than one filled in by somebody who was not there.
// GOTCHA: **head_teacher was a DEAD GRANT here** — they hold
`attendance.amend.review`, making them the second person on the chain that
corrects a stale register, and the API returned them ZERO classes because they
were missing from `SCHOOL_WIDE_ROLES`: an approver who cannot see what the
decision turns on. Its own neighbour asserted the intent all along, which is a
comment claiming an agreement that did not exist. It grants SIGHT, not cover.
// `GET /attendance/registers` now carries the class teacher, and `RegisterBoard`
on /attendance shows BOTH lists — still-to-take with the person to ask, and a
collapsed "Taken (n)" — where it used to show only a count of the gaps. The
manual trigger is SCHOOL-scoped (`attendance.write`), never the fleet.

## Staff attendance: a SPAN, closed by a sweep, corrected by two people
It recorded ARRIVALS only and the biometric ingest dropped departure scans as
duplicates. Scans append to `staff_attendance_event` (rls/113, append-only); the
day row is a PROJECTION — first IN, last OUT. // GOTCHA: clock-OUT is NOT
windowed (a window catches a late ARRIVAL), and `minutesOnSite` is NULL not 0.
// **ABSENCE WAS NEVER RECORDED** — `summary()` counts rows that EXIST, so anyone
who never clocked in was neither. `StaffDayCloseService` acts on each school's own
19:00 (late, or evening activities become absences): unmarked -> ABSENT, approved
leave -> ON_LEAVE; `openSpans` apart; ONE `createMany` per school, counting what
was WRITTEN. // **EVERY READER COULD REWRITE THEIR OWN RECORD**:
`hr.attendance.read`/`.amend` split, self-marking REFUSED, past 7 days needs a
senior `.amend.review` holder. `/kiosk` shows the code alone — it needed
`hr.read`, so the corridor screen showed the register.

## A CARD THAT DOES NOT RENDER LOOKS EXACTLY LIKE ONE THAT SHOULD NOT
`/classes` gated its create-a-class card on `students`, which the page had been
changed to fetch as a bare `Promise.resolve(null)` — so the ONLY route to
creating a class was absent for every role, silently. Gate:
`a-card-that-can-never-render`. // GOTCHA: a probe searching for a string it did
not take FROM THE THING IT TESTS asks about the page, not the component.
// A class teacher is EXPECTED, NOT REQUIRED — the rule asserted an invariant the
data lacks (30 of 31 have none) and blocked laying out next year before staffing.
NAMED OR NOBODY: a pupil or leaver refused, an existing one cannot be cleared.
// `POST /classes/arms` creates a stream's arms at once; `Class.homeRoomId` is a
BASE room (one per class, refusal names the holder), distinct from the
per-SUBJECT `preferredRoomId`. Syllabus and notes copy to arms too: SKIP never
overwrite, notes land DRAFT keeping the (subject, term) gradebook tag.

## MEASURE AT THE LEVEL A USER MEETS, NOT ONLY IN EXPLAIN
A lifetime `groupBy` on a partitioned table is 64.8ms planning / 3.5ms execution —
and the ENDPOINT cannot tell 63 partitions from 15 (24ms vs 26ms). Postgres caches
the plan PER PREPARED STATEMENT PER CONNECTION (first EXECUTE 18.4ms, then 0.8ms)
and Prisma pools connections, so it is paid once per connection, not per request.
EXPLAIN forces a fresh plan; production does not. **Three unbounded reads found by
a sweep were therefore LEFT ALONE.**
// **What DOES degrade is HYDRATION.** `/operator/analytics` fetched every
`student_profile` on the platform for two histograms: 0.5s at 0 pupils, 3.2s at
200,000, against 64ms for the same question as an aggregate — 4.5M rows and ~70s
at the 5,000-school target. The per-school sibling already did it in SQL.
// **The PUBLIC front door shipped the fleet**: `/public/schools` returned every
school unpaged and unsearchable (678 KB, 631ms, the slowest page in the app), its
own comment conceding the shape and answering with a rate limit — which bounds how
OFTEN the cost is paid, not the cost. Paged + searched in SQL: 6.8 KB, 42ms.
// GOTCHA: a route on the PUBLIC controller without `@Public()` answers 401, and
the only symptom was a school's own enrol link silently not preselecting it.

## O(lifetime) ALSO ARRIVES AS PARTITION COUNT — the SLICING pays, not the planning
An aggregate over `attendance_record` with no date predicate PLANS every partition
(unbounded 88.6ms planning / 9.4ms execution; bounded to a year 0.58 / 1.3), and
planning tracks the PLATFORM's age. **Bound every aggregate over a partitioned
table by date; make the PAGE a window, not a slice** — and keep at most ONE
unbounded pass (the lifetime audit total), returning the SPAN so the total needs
no second scan.
// GOTCHA: **a window is anchored on the RECORD, not on today** — counted back
from today it lands after a LEAVER's final register: an empty page 1 under a total
saying thirty months exist, and a leaver is this screen's likeliest reader.
// GOTCHA: Postgres REFUSES a partition for a month with rows already in DEFAULT;
`AuditPartitionService` detects it and counts `failed`, and there is no remedy tool.
// GOTCHA: **an unindexed FK is harmless until somebody PURGES.** A user delete is
checked by `audit_log."actorId"` on a PARTITIONED table with no index on it, so it
scans every partition: 12 minutes without finishing. The remedy works — 71
temporary indexes in 0.9s, then 410k rows in 8m36s — but the recorded
"1,370,900 rows in 3m6s" is ONE fixture, not a rate.

## A pupil's attendance compiles at THREE grains, and says which are settled
`GET /students/:id/attendance/compiled?grain=month|term|session`. Scoping is
INHERITED from `assertCanAccessStudent`, not restated. // GOTCHA:
`attendance_term_rollup` covers ENDED terms ONLY, so reading it alone shows the
CURRENT term as zero — "never attended" rather than "not settled". Unrolled terms
compute LIVE, every bucket carries `source: ROLLUP|LIVE`, and a session is only as
settled as its least settled term. // GOTCHA: the rollup is keyed
`(termId, classId, studentId)` — a pupil who moved class mid-term has SEVERAL
rows and they must be SUMMED, or you report a fraction of the term and it looks
entirely normal. // A session is summed from the TERM buckets, never a second
query.

## A staff record is read PER PERSON, and must not grow with their service
`GET /hr/attendance/staff/:userId` + the card on `/hr/staff/[userId]`: months
COMPILED IN SQL and paged. A per-day read is O(length of SERVICE); on 250,440
rows the covering `INCLUDE (status, flagged, clocks)` took it 41.8ms -> 12.5ms
(Index Only Scan) while a plain composite did not pay for its write cost — for
PUPILS the same measurement said add NO index. // GOTCHA: `DROP INDEX; CREATE
INDEX CONCURRENTLY` in one `psql -c` is one transaction and CONCURRENTLY cannot
run in one — the pair rolls back and you then measure the index you think you
dropped.
## Attendance register — write windows (BUILT)
Three tiers gate a register write (`AttendanceService.markAttendance`):
- **≤7 days old**: applied directly.
- **>7 days old (STALE), current term**: a plain teacher's edit raises an
  `ATTENDANCE_AMENDMENT` workflow (systemOnly; single-stage
  `ATTENDANCE_AMENDMENT_CHAIN`, perm `attendance.amend.review` held by
  head_teacher/school_admin/principal) — a DIFFERENT senior approves (SoD,
  engine-enforced) and a WorkflowHooks reactor applies the marks in-tx. Scan
  CHECK_IN is always today → never stale.
  // GOTCHA: this said amend.review holders edit stale registers DIRECTLY —
  **false for two of the three roles holding it**. BOTH branches call
  `assertCanTakeRegister`, so a correction is gated like a fresh register.
  Measured at day 10: teacher 201 pendingApproval, school_admin 201 direct,
  principal AND head_teacher **403**. amend.review APPROVES an amendment, never
  authors one (`who-corrects-a-stale-register.spec.ts`). KNOWN, NOT FIXED: a
  school may run with a principal and NO school_admin, so if the supervisor has
  LEFT, that class's stale register can be corrected by nobody.
- **Past/ended term**: fully LOCKED (409), no edit even with approval — boundary
  is the `isCurrent` term's startDate (fail-open when unconfigured);
  `GET /attendance/term-lock` exposes it. `STALE_REGISTER_DAYS = 7`.
`attendance.amend.review` is a NEW permission → re-run the seed on a live DB (the
guard reads role→perms from the DB).

## August 2026 correctness pass — what changed, and the rules behind it
Twenty-five fixes found by asking, of each control, "is it applied on every path
that does the thing?" The durable facts:

- **A REGISTER IS NOT A QUEUE.** `LIST_CAP = 500` claims inbox views "only
  surface the most-recent page" — true of live work, false when the list is also
  the record a school reads LATER. Approvals, leave and assessments take filters
  + `page` and return the MATCHING total (before: 702 workflow requests returned
  500). Filter in SQL, and a search must AND onto the caller's scoping. `mine=1`
  is narrowed in memory ON PURPOSE (a stage permission inside JSON), safe only
  because live work is bounded. A fee run's DRAFTs finish with
  `POST /invoices/issue-bulk` — there was no batch way to issue a batch.
- **ELEVATION REACHES THE UI.** `activeGrantPermissions` is the ONE definition of
  what a grant gives, called by the guard AND by login/refresh. Before, a grant
  was honoured by the API and lit up no screen. A stage decided under a grant is
  in the IMMUTABLE trail — the reviewer's comment no longer REPLACES the
  system's notes (`??` became a join), which is where that fact vanished.
- **"TODAY" IS THE SCHOOL'S DAY** — including the transport boarding register
  (keyed on `(passenger,date,direction)`, so a wrong day OVERWRITES another
  journey). Remaining `toISOString()` uses label a document, never key a record.
- **A CONTROL WITH ANOTHER WAY ROUND IT IS NOT A CONTROL.** The leaver document
  gate ran on `getDownloadUrl`, not `streamFile` — the door the web uses. Both
  call one `assertReleasable`. A RECEIPT is never gated: withholding personal
  data over a debt is unlawful, not firm.
- **EXITED USERS CANNOT AUTHENTICATE.** `validateLogin`, `refreshClaims` and the
  password-reset path all refuse a non-ACTIVE user, which BOUNDS a whole class of
  "a leaver still has X" worries. A class change deliberately does NOT end a
  conversation, because that moves it to WhatsApp.
- **MONEY MUST SAY WHERE IT WENT.** A library fine lands on an ISSUED invoice (a
  DRAFT is not a bill — hidden from families and out of receivables, so an UNPAID
  fine was visible only by being paid), records the METHOD, and bills the charge
  rather than taking cash with nothing on the ledger.
- **REPORT WHAT YOU DID NOT DO.** The exeat sweep marked every overdue boarder
  as handled including the ones it could tell nobody about; it now marks only
  what it alerted, and alerts the FAMILY in their own words. An alumni broadcast
  reports `unreachable` (records with no linked account). The attendance rollup
  had no sweep at all — built, consumed by `useRollup`, and never populated;
  nightly now (`attendance.rollup` in the jobs catalogue), 452 ms -> 32 ms with
  IDENTICAL figures.
- **A SIGNAL IS NOT A PENALTY.** Scholarship signals report `disciplineUpheld`
  and `disciplineOpen` separately, never a DISMISSED complaint — `discipline.file`
  is held by students, so one count let a classmate's accusation count against a
  child asking for help with fees.

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

## Container images: GHCR is annotated, production is ECR
`scripts/push-images.sh` is the ONLY supported way to push the api/web images to
GHCR. Production does not use GHCR at all — `ecs.tf` pulls
`aws_ecr_repository.this["api"|"web"]` at `var.image_tag`, `deploy.yml` sets that
to the git SHA on an ARM runner, and the ECR repos are tag-IMMUTABLE. The script
hard-codes `ghcr.io` and refuses any registry matching `*ecr*`/`*amazonaws*`.
// GOTCHA: **a Dockerfile `LABEL` does NOT link a package to its repository.**
`LABEL org.opencontainers.image.source` is a config label on the CHILD image;
buildx pushes an OCI image INDEX and GHCR reads `source` from an ANNOTATION on
that index, never descending into the config. Both packages sat orphaned for as
long as they existed while `docker inspect` showed the label exactly as written
and every build, push and inspect exited zero. The fix is
`--annotation "index:org.opencontainers.image.source=…"`; **the `index:` prefix
IS the fix** — without it the annotation lands on the child manifest and nothing
links, still silently. The labels stay (they are what `docker inspect` reads) but
they are not the mechanism, and the comments that said they were are corrected.
// The script VERIFIES by re-reading the pushed index, because the entire defect
// was a push that succeeded and linked nothing. A clean exit is not evidence.
// Gate: `a-label-that-linked-nothing` — it DRIVES the script under `DRY_RUN`
// rather than parsing the bash, which is what the first draft did and why it
// matched nothing once the scopes moved into a loop.

## An upload is a CLAIM until the server looks at the bytes
The presigned PUT goes browser→bucket, so confirm is the only moment the API can
check — and the LMS one checked nothing: it set `fileUploaded` on the caller's
word. Three facts are settled there and none earlier: the bytes ARRIVED (a
failed PUT still said "Attached", and pupils got a refusal from storage), they
fit (the presign's `sizeBytes` is a number the caller SENT), and they are the
type claimed (`sniffUploadType`, magic bytes). A refusal leaves it unattached so
the upload can simply be retried.
// **A DELETE ON A VERSIONED BUCKET DELETES NOTHING.** `DeleteObject` with no
// VersionId writes a DELETE MARKER and keeps the bytes, and ten call sites rely
// on a delete deleting — NDPR erasure, recording retention, the declined-
// applicant purge. Each reported success and left the object for ever. The
// remedy is a LIFECYCLE RULE (`noncurrent_version_expiration`), not app code:
// S3 expires them itself, so no new IAM and no way for a future caller to
// forget. Versioning's protection is a WINDOW, and that window is also the lag
// on every promised deletion — 7 days here, short because minors' records.
// **A SIZE CAP IS SIZED AGAINST WHAT THE TOOL PRODUCES, not a round number.**
// A recording cap of 500 MB for two hours is 0.56 Mbps and refuses even 480p —
// Zoom 720p slides is ~0.7 GB, with a camera ~1.4 GB, OBS at 1080p ~2.2 GB. So
// `MAX_RECORDING_BYTES` is 1.5 GB: every 720p double lesson, not the 1080p dump
// (which is an hour of uploading on a school line, i.e. mostly abandoned PUTs).
// **A per-file cap does not control the storage bill** — the COUNT does, and
// that is bounded by the RETENTION window. And the refusal names the way OUT
// ("record at 720p"), from ONE shared message, because there are two doors:
// presign (the caller's own `sizeBytes` claim, refused there to save the hour)
// and confirm (the bytes themselves).
**`inline` is the TYPE the server vouches for, never a boolean** — that is what
keeps the check joined to the serving, and it lets S3 pin
`ResponseContentType` rather than return the object's stored type, which came
off the PUT and is the uploader's claim. Locally the type rides the SIGNED OP
(`get-inline-pdf`), never a query parameter.
// GOTCHA: the feature could not work locally AT ALL — `KEY_SHAPE` admitted
`schools/` and `careers/`, the prefixes that existed when it was written, while
`lms/`, `discipline/`, `submissions/` and `tasks/` were added later: four upload
features 400ing at the FIRST step, behind a refusal deliberately worded like a
bad signature. Gate `a-key-no-upload-could-use` computes the minted set from
source. // **AND A SECOND CEILING NEEDS SWEEPING LIKE ANY OTHER RULE.** Document 10 MB
// vs recording 1.5 GB: the presign and confirm enforced the right one and the
// door BETWEEN them applied the document cap to everything, so the local stack
// could not upload a recording at all (nginx 413 at 12m, then the API at 10 MB,
// then a Buffer that would have OOM'd). Put the ceiling in the SIGNED OP, the
// way the inline TYPE already is — one table, unknown type gets the narrower
// one, and it cannot be widened by editing a URL.
// GOTCHA: the school LOGO was presigned in FIVE places, three inline
and two not — the two being the PUBLIC ones, so a PAID logo never rendered on
the login page. One `logoUrl()` now; the gate asserts exactly ONE presign site.

## A BULK TEMPLATE IS A CONTRACT WITH THE COMPLETION RULE
The SIS template had no `city`/`state` column while `SIS_REQUIRED_PROFILE_FIELDS`
demands both — so a school importing an ACCURATE, COMPLETE register had every
pupil land INCOMPLETE and the nightly sweep nudged every one of them, and their
guardians, for two facts it had never been offered anywhere to type. A nudge must
mean "we genuinely do not know this".
**What belongs in a template:** every fact THE SCHOOL is the authority on, plus
every field required for completeness; the rest is asked of the family, who are
the authority on it. Medical and emergency contacts stay OUT — encrypted,
separately audited, and a spreadsheet is the wrong custody. `SIS_IMPORT_COLUMNS`
is the ONE definition; gate `a-template-that-can-finish-a-profile` parses the
template's OWN worked example and fails unless a pupil built from it needs no
chasing (and that the SPARSE example still does, or the file teaches nothing).
// GOTCHA: **a `z.object` at the boundary STRIPS what it does not declare**, and
it was a THIRD hand-kept copy of the column list — so the new columns were
offered, typed in, sent and discarded at the door, every status a success and
EVERY UNIT TEST GREEN (they drive the service and never cross it). Only running
the import found it. Fix is the type system: keys `as const` plus
`Exclude<Key, keyof shape> extends never ? true : [...]`, so the next column
fails to COMPILE naming itself. A `Record<Key, true>` written with an `as` cast
does NOT work. Under `as const` an OMITTED property leaves the union, so every
entry states all four, nulls included.
// GOTCHA: `line.split(",")` — the address is the field likeliest to hold a comma
and a spreadsheet quotes it, so `"12 Main St, Ikeja"` truncated the address AND
shifted every later column, enrolling the pupil in a class called `Ikeja"`.
`parseCsv` handles quotes, embedded newlines, `""`, CRLF and the BOM Excel writes
(which otherwise lands in the FIRST HEADER, so every row has no name).
// GOTCHA: an import that only CREATES is a one-shot. Upsert on the admission
number — **a blank cell never clears a stored value** (`COALESCE(v,p)`), or a
re-upload carrying only addresses wipes every date of birth and nothing reports
it. An update rewrites a child's record, so it keeps maker-checker and the
approver is shown the FIELDS that change. Decide which rows are updates BEFORE
hashing (bcrypt ~100ms/row; an update needs no account) and write them as ONE
`UPDATE … FROM (VALUES …)` per chunk, never a loop inside the 5-second
interactive transaction. The roster export round-trips the template, so
correcting a roll is a download and an upload, not one pupil at a time for ever.

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
- **A PROCEDURE NOBODY HAS RUN IS A HYPOTHESIS.** `deploy.yml` has failed 100 of
  its last 100 runs (no AWS credentials), so the production path has never
  executed, and `PRODUCTION_DEPLOYMENT.md` is gated only for EXISTENCE.
  `infrastructure/scripts/go-live-rehearsal.sh` EXECUTES it instead:
  **PASS / FAIL / SKIP, where a SKIP is a FINDING** — a check that could not run
  is named with its reason, never counted as a pass, and an all-SKIP run exits
  non-zero because a rehearsal that checked nothing must not read like a clean
  one. // GOTCHA it found on its first run: the go-live gate's `/metrics` check
  **could never see what it was for** — the ALB forwards only `/ws/*` to the API,
  so `<domain>/metrics` hits the WEB tier and returns 307, and no METRICS_TOKEN
  mis-wiring could ever show as the 200 it warned about. Aim a check at the path
  that reaches the service, or assert the property the routing actually
  promises.

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
  `SESSION_DISCOUNT_PERCENT` and the `PLANS` count from `@sms/types`; never type a
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