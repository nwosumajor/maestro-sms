# API Reference — School Management System

Every HTTP endpoint the NestJS API (`apps/api`) declares: **906 routes across 90 controllers.**

> **This file is GENERATED** — `pnpm --filter @sms/api build:api-doc`. Do not hand-edit it; a route added to a controller appears here on the next run, and `api-doc-is-current.spec.ts` fails the build if it has not been. To improve a description, edit `apps/api/scripts/api-doc-purposes.json` or write a doc comment on the handler.

## Conventions

- **Base URL:** the API is stateless and mounted at the service root (e.g. `http://localhost:3001`). The Next.js web app reaches it through a same-origin BFF proxy (`/api/sms/*` for authed calls, `/api/public/*` for public ones) which injects the Bearer token server-side.
- **Auth:** every non-public request carries a Bearer JWT (HS256, `algorithms: ["HS256"]` pinned) minted by the Auth.js layer at login; it holds `userId`, `school_id`, `roles`, `permissions`. The API **verifies** it on every request and never issues sessions. A token minted for another purpose — an invite link, a password reset, a step-up, a signed upload — is refused as a session bearer.
- **Tenant isolation (3 layers):** JWT `school_id` claim → NestJS `PermissionGuard` → Postgres Row-Level Security. Cross-tenant access returns **404, not 403** (never leak existence).
- **Every mutation is audit-logged** (actor, action, entity, `school_id`, timestamp).
- **Rate limiting:** `POST /auth/login` is 10/min/IP and the public read surface 60/min. Gateway webhooks and the biometric ingestion endpoint are deliberately UNLIMITED — a 429 turns a burst of real payments into a retry storm, and a mobile-money callback is delivered once, so refusing it loses the payment.
- **Responses are `private, no-store`** and vary on `Cookie`; the public surface deliberately does not, since it is identical for every caller.

### Gate legend

| Symbol | Meaning |
|---|---|
| 🌐 **public** | `@Public()` — no authentication |
| 🔑 **perm** | `@RequirePermission(...)` — the fine-grained permission checked by the guard and backstopped by RLS. Several listed means ANY one of them suffices. |
| 📦 **module** | `@RequireModule(...)` — the school's subscription must include the module, else **404**. Resolved BEFORE the permission check. |
| ⬆️ **step-up** | `@RequireStepUp()` — a fresh 5-minute re-auth token is required (`x-stepup` header) |
| (auth) | authenticated, with no further gate |

---

## Foundation, auth & session

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/auth/change-password` | (auth) | Change your own password (voluntary, or to satisfy the forced 30-day reset). |
| POST | `/auth/login` | 🌐 public | Verify credentials + MFA + 3-strike lockout, return the signed session JWT + modules |
| GET | `/auth/refresh` | (auth) | Mid-session claim revalidation for the web's jwt callback. |

---

## Public surface (no authentication)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/public/invite/accept` | 🌐 public | PUBLIC: accept a provisioning invite (set the account's first password). |
| POST | `/public/onboarding-requests` | 🌐 public | A prospective school requests to join (homepage CTA) |
| POST | `/public/password-reset/confirm` | 🌐 public | PUBLIC: apply a forgot-password reset (single-use signed token). |
| POST | `/public/password-reset/request` | 🌐 public | PUBLIC: request a forgot-password reset email. |
| GET | `/public/plan-pricing` | 🌐 public | Effective per-tier pricing (operator overrides merged over defaults) — the landing page derives its prices from this |
| GET | `/public/schools` | 🌐 public | Public list of onboarded schools (parent directory; excludes the platform org) |

---

## Health & metrics

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/metrics` | 🌐 public | Prometheus metrics scrape (process + HTTP + per-tenant counters) |

---

## Security, MFA & privilege elevation

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/security/anomalies` | 🔑 `security.audit.read` | Access-anomaly signals |
| GET | `/security/audit` | 🔑 `security.audit.read` | Scoped, filterable audit-log viewer |
| GET | `/security/elevation` | 🔑 `security.elevation.request` | List privilege-elevation grants |
| POST | `/security/elevation/:id/approve` | 🔑 `security.elevation.approve` | Approve elevation (must be a different person) |
| POST | `/security/elevation/:id/revoke` | 🔑 `security.elevation.approve` | Revoke an active grant |
| POST | `/security/elevation/delegate` | 🔑 `security.elevation.approve` | HAND OVER a duty you already hold to a colleague, for a bounded window — cover for leave, without waiting to be asked. |
| POST | `/security/elevation/request` | 🔑 `security.elevation.request` | Request just-in-time elevation (or break-glass) |
| POST | `/security/mfa/disable` | ⬆️ step-up | Disable MFA (step-up required) |
| POST | `/security/mfa/enroll` | (auth) | Begin TOTP enrolment |
| GET | `/security/mfa/status` | (auth) | Current user's MFA enrolment status |
| POST | `/security/mfa/verify` | (auth) | Confirm TOTP enrolment |
| GET | `/security/recertification` | 🔑 `security.audit.read` | Access-recertification report |
| POST | `/security/stepup` | (auth) | Mint a 5-minute step-up token for sensitive actions |

---

## Super-admin operator console (platform owner)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/operator/addon-pricing` | 🔑 `platform.tenants.read` | Add-on prices, one row per module the platform sells on its own. |
| PUT | `/operator/addon-pricing` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Set add-on prices. |
| GET | `/operator/admin-appointments` | 🔑 `platform.tenants.read` | Cross-tenant junior-admin ADMIN_APPOINTMENT oversight (`?state=` filter; read-only — the school's second senior decides) |
| GET | `/operator/agents` | 🔑 `platform.tenants.read` | List Agents |
| POST | `/operator/agents` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Create Agent |
| PUT | `/operator/agents/:id/active` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Set Agent Active |
| GET | `/operator/analytics` | 🔑 `platform.tenants.read` | Graphical platform business metrics (MRR, ARPA, growth, funnel, churn, module adoption, demographics) |
| GET | `/operator/attention` | 🔑 `platform.tenants.read` | The schools that need a DECISION, ranked worst-first — six conditions with the figure behind each. |
| GET | `/operator/audit` | 🔑 `platform.audit.read` | Cross-tenant audit trail, actor-attributed (email + unique id + roles), cursor-paginated |
| GET | `/operator/audit/export.csv` | 🔑 `platform.audit.read` | Downloadable CSV audit report (formula-injection safe) |
| GET | `/operator/billing-alerts` | 🔑 `platform.tenants.read` | Tenants currently past their paid period (red banner on the console). |
| GET | `/operator/commissions` | 🔑 `platform.tenants.read` | List Commissions |
| POST | `/operator/commissions/:id/paid` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Mark a commission settled to the agent (money moved outside the system). |
| GET | `/operator/countries` | 🔑 `platform.tenants.read` | The countries the platform is set up to serve, with their defaults. |
| GET | `/operator/directory` | 🔑 `platform.tenants.read` | Searchable school directory: proprietor + admin/principal contacts, onboarding date, subscription posture, last payment, seat arrears. |
| GET | `/operator/games-analytics` | 🔑 `platform.tenants.read` | Fleet-wide GAMES adoption/engagement — aggregate counts only, PII-free. |
| GET | `/operator/groups` | 🔑 `platform.tenants.read` | List Groups |
| POST | `/operator/groups` | 🔑 `platform.subscription.manage` · ⬆️ step-up | Create Group |
| PUT | `/operator/groups/:id/directors` | 🔑 `platform.subscription.manage` · ⬆️ step-up | Replace a group's directors (by email; must belong to a member school). |
| PUT | `/operator/groups/:id/members` | 🔑 `platform.subscription.manage` · ⬆️ step-up | Replace a group's member schools. |
| POST | `/operator/impersonate` | 🔑 `platform.impersonate` · ⬆️ step-up | Mint an audited, scoped impersonation token |
| GET | `/operator/jobs` | 🔑 `platform.tenants.read` | Every scheduled job, and whether it has actually been running. |
| POST | `/operator/maintenance/index-bloat/run` | 🔑 `platform.operate` | Reclaim index space now (it also runs weekly). |
| GET | `/operator/message-credits` | 🔑 `platform.tenants.read` | Cross-tenant balance list — every school's current SMS/WhatsApp credit position, searchable by name. |
| POST | `/operator/message-credits/:schoolId/adjust` | 🔑 `platform.subscription.manage` · ⬆️ step-up | Comp or debit a school's credit balance. |
| GET | `/operator/message-credits/:schoolId/ledger` | 🔑 `platform.tenants.read` | One school's credit ledger (purchases, sends, comps), newest first. |
| GET | `/operator/message-credits/reconciliation` | 🔑 `platform.tenants.read` | Fleet-wide credit reconciliation posture. |
| GET | `/operator/onboarding-requests` | 🔑 `platform.onboarding.review` | Review queue of public onboarding requests |
| POST | `/operator/onboarding-requests/:id/status` | 🔑 `platform.onboarding.review` | Approve / reject / mark-reviewing a request |
| GET | `/operator/payment-channels` | 🔑 `platform.tenants.read` | Which payment rails the platform will START a charge on, plus the impact of the current setting: schools that could not be charged at all under it. |
| PUT | `/operator/payment-channels` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Set the enabled rails. |
| POST | `/operator/payment-channels/:channel/test` | 🔑 `platform.pricing.manage` | Prove a rail works by CALLING it. |
| GET | `/operator/payment-channels/currency-coverage` | 🔑 `platform.tenants.read` | Which currencies the platform's card account can charge, and which schools are waiting on each. |
| POST | `/operator/payment-channels/health/run` | 🔑 `platform.pricing.manage` | Run the daily health check now (it also runs on a schedule). |
| GET | `/operator/payments` | 🔑 `platform.revenue.read` | Every subscription payment across every tenant, filtered by PERIOD. |
| GET | `/operator/payments/export.csv` | 🔑 `platform.revenue.read` | The same filter as a CSV for the books. |
| GET | `/operator/platform-delegations` | 🔑 `platform.staff.manage` | Every duty lent to a platform manager — live, expired and handed back. |
| POST | `/operator/platform-delegations` | 🔑 `platform.staff.manage` · ⬆️ step-up | Lend one duty to one platform manager, for a bounded window. |
| POST | `/operator/platform-delegations/:id/revoke` | 🔑 `platform.staff.manage` | Take a duty back early. |
| GET | `/operator/platform-delegations/lendable` | 🔑 `platform.staff.manage` | Which platform duties may be LENT at all. |
| GET | `/operator/platform-fees` | 🔑 `platform.tenants.read` | The platform's convenience fee on online fee collection (take-rate). |
| PUT | `/operator/platform-fees` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Set the take-rate. |
| GET | `/operator/platform-role-audit` | 🔑 `platform.staff.manage` | AUDIT: platform-tier roles held outside the platform org (should be none). |
| DELETE | `/operator/platform-role-audit/:userId/:roleName` | 🔑 `platform.staff.manage` · ⬆️ step-up | Strip a misplaced platform-tier grant. |
| GET | `/operator/platform-staff` | 🔑 `platform.staff.manage` | Current platform managers. |
| POST | `/operator/platform-staff` | 🔑 `platform.staff.manage` · ⬆️ step-up | Hire a platform manager (manager_admin). |
| POST | `/operator/platform-staff/:userId/invite` | 🔑 `platform.staff.manage` · ⬆️ step-up | Re-issue a manager's set-password link (expired, lost, or never delivered). |
| POST | `/operator/platform-staff/:userId/revoke-duties` | 🔑 `platform.staff.manage` · ⬆️ step-up | Hand back EVERY duty lent to one manager at once — the leaver / lost-laptop button. |
| PUT | `/operator/platform-staff/:userId/status` | 🔑 `platform.staff.manage` · ⬆️ step-up | Revoke / reinstate a platform manager. |
| GET | `/operator/pricing` | 🔑 `platform.tenants.read` | Effective per-tier pricing + default/override flags |
| PUT | `/operator/pricing` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Set per-tier per-seat prices (platform-wide; feeds quotes, checkout and the public page; audited) |
| GET | `/operator/promos` | 🔑 `platform.tenants.read` | List Promos |
| POST | `/operator/promos` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Create Promo |
| PUT | `/operator/promos/:id/active` | 🔑 `platform.pricing.manage` · ⬆️ step-up | Set Promo Active |
| GET | `/operator/schools/:schoolId/profile` | 🔑 `platform.tenants.read` | The complete operator-facing profile of one school. |
| GET | `/operator/tenant-names` | 🔑 `platform.tenants.read` | Lightweight id+name list for pickers (single query) |
| GET | `/operator/tenants` | 🔑 `platform.tenants.read` | Cross-tenant school registry — server-side search/filter/pagination (`q`, `plan`, `billing`, `page`, `pageSize` → `TenantPageDto`) |
| POST | `/operator/tenants` | 🔑 `platform.tenants.write` · ⬆️ step-up | Provision a new school + its founding admin tier |
| POST | `/operator/tenants/:schoolId/admins` | 🔑 `platform.tenants.write` · ⬆️ step-up | Add an admin to an existing school |
| PUT | `/operator/tenants/:schoolId/grace` | 🔑 `platform.grace.manage` · ⬆️ step-up | Per-school grace window. |
| PUT | `/operator/tenants/:schoolId/region` | 🔑 `platform.tenants.region` · ⬆️ step-up | Set a school's REGION: country, and optional timezone / locale / fee-currency / compliance overrides. |
| PUT | `/operator/tenants/:schoolId/roles/:roleName/mfa-required` | 🔑 `platform.user.credentials` · ⬆️ step-up | Mandate MFA for a role |
| GET | `/operator/tenants/:schoolId/settlement-holding` | 🔑 `platform.tenants.read` | What the platform is holding for a school, and what it has already paid over. |
| POST | `/operator/tenants/:schoolId/settlement-release` | 🔑 `platform.subscription.manage` · ⬆️ step-up | Record that the platform has PAID a school what it was holding. |
| PUT | `/operator/tenants/:schoolId/status` | 🔑 `platform.tenants.status` · ⬆️ step-up | Enable/disable a SCHOOL — the hard deactivation lever (blocks every member login; nothing deleted). |
| GET | `/operator/tenants/:schoolId/students` | 🔑 `platform.student.read` | Cross-tenant student view — by ROLE (not-yet-enrolled included), active class names attached; audited |
| POST | `/operator/tenants/:schoolId/students/export` | 🔑 `platform.student.read` · ⬆️ step-up | NDPR bulk export of a school's student data (records requested by the school, e.g. years later). |
| GET | `/operator/tenants/:schoolId/subscription` | 🔑 `platform.tenants.read` | A school's subscription (plan + modules) |
| PUT | `/operator/tenants/:schoolId/subscription` | 🔑 `platform.subscription.manage` · ⬆️ step-up | Set plan + per-module overrides / comp status |
| GET | `/operator/tenants/:schoolId/users` | 🔑 `platform.user.read` | Cross-tenant user view |
| PUT | `/operator/tenants/:schoolId/users/:userId/mfa-required` | 🔑 `platform.user.credentials` · ⬆️ step-up | Mandate MFA for a user |
| POST | `/operator/tenants/:schoolId/users/:userId/mfa/reset` | 🔑 `platform.user.credentials` · ⬆️ step-up | Reset a user's MFA |
| POST | `/operator/tenants/:schoolId/users/:userId/reset-password` | 🔑 `platform.user.credentials` · ⬆️ step-up | Issue a temporary password |
| PUT | `/operator/tenants/:schoolId/users/:userId/status` | 🔑 `platform.user.credentials` · ⬆️ step-up | Enable/disable a user account |
| POST | `/operator/tenants/:schoolId/users/:userId/unlock` | 🔑 `platform.user.unlock` | Clear a failed-login lockout |

---

## Admissions

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/admissions` | 🔑 `admission.review` · 📦 `admissions` | List — admissions |
| GET | `/admissions/:id` | 🔑 `admission.review` · 📦 `admissions` | Get One |
| POST | `/admissions/:id/convert` | 🔑 `class.write` · 📦 `admissions` | Enrol an accepted applicant. |
| POST | `/admissions/:id/exam` | 🔑 `admission.review` · 📦 `admissions` | Schedule / update the entrance exam (communicated to the applicant on acceptance). |
| POST | `/admissions/:id/review` | 🔑 `admission.review` · 📦 `admissions` | Review |
| GET | `/admissions/settings/form-fee` | 🔑 `admission.review` · 📦 `admissions` | The school's current form fee (any admission reviewer can see it). |
| PUT | `/admissions/settings/form-fee` | 🔑 `fee.manage` · 📦 `admissions` · ⬆️ step-up | Finance staff set the school's admission-form fee (0 = free). |
| POST | `/public/admissions` | 🌐 public · 📦 `admissions` | Public admissions application |
| POST | `/public/admissions/:id/pay/init` | 🌐 public · 📦 `admissions` | PUBLIC: (re)start the form-fee checkout for an existing application — covers an abandoned first redirect. |

---

## Alumni

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/alumni` | 🔑 `alumni.manage` · 📦 `alumni` | `alumni` | Alumni records |
| PUT | `/alumni/:id` | 🔑 `alumni.manage` · 📦 `alumni` | Update — alumni |
| POST | `/alumni/broadcast` | 🔑 `alumni.manage` · 📦 `alumni` | Broadcast |

---

## Analytics

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/analytics/overview` | 📦 `analytics` | Role-scoped analytics (attendance, grades, fees, demographics) |
| GET | `/analytics/overview.csv` | 📦 `analytics` | The same figures as CSV, for a board pack. |

---

## Announcements

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/announcements` | 🔑 `announcement.read` | — | Announcements |
| POST | `/announcements` | 🔑 `announcement.manage` | — | Announcements |
| DELETE | `/announcements/:id` | 🔑 `announcement.manage` | — | Delete an announcement |

---

## Approval workflow engine

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/workflows` | 🔑 `workflow.read` · 📦 `workflow` | The approvals register: filtered, searchable, paged. |
| POST | `/workflows` | 🔑 `workflow.create` · 📦 `workflow` | Start a multi-stage approval request |
| GET | `/workflows/:id` | 🔑 `workflow.read` · 📦 `workflow` | The whole story of one request — the chain as designed, who decided each stage (and whether under an elevation grant), and the immutable trail. |
| POST | `/workflows/:id/review` | 🔑 `workflow.review` · 📦 `workflow` | Approve/advance a stage (separation of duties) |
| POST | `/workflows/:id/submit` | 🔑 `workflow.create` · 📦 `workflow` | Submit for review |
| POST | `/workflows/:id/veto` | 🔑 `workflow.veto` · 📦 `workflow` | Board veto |
| GET | `/workflows/approvers` | 🔑 `workflow.create` · 📦 `workflow` | Senior staff the caller may route approval stages to. |

---

## Approvals (aggregated queue)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/approvals/pending` | (auth) | Everything pending THIS caller's decision, across every module. |

---

## Assessment integrity

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/assessments` | 🔑 `assessment.read` · 📦 `integrity` | List / create assessments |
| POST | `/assessments` | 🔑 `assessment.write` · 📦 `integrity` | List / create assessments |
| PUT | `/assessments/:assessmentId` | 🔑 `assessment.write` · 📦 `integrity` | Edit an assessment |
| GET | `/assessments/:assessmentId/submissions` | 🔑 `integrity.report.read` · 📦 `integrity` | Submissions for review |
| POST | `/assessments/:assessmentId/submissions/:submissionId/autosave` | 🔑 `submission.write` · 📦 `integrity` | Autosave a draft (append-only snapshot) and enqueue detection. |
| GET | `/assessments/:assessmentId/submissions/:submissionId/file` | 🔑 `submission.read` · 📦 `integrity` | Download a submission's file: the owner student, or a reviewer (teacher/staff). |
| POST | `/assessments/:assessmentId/submissions/:submissionId/file/confirm` | 🔑 `submission.write` · 📦 `integrity` | Student confirms their file finished uploading. |
| POST | `/assessments/:assessmentId/submissions/:submissionId/file/presign` | 🔑 `submission.write` · 📦 `integrity` | Student requests an upload URL for their own file answer. |
| GET | `/assessments/:assessmentId/submissions/:submissionId/integrity-report` | 🔑 `integrity.report.read` · 📦 `integrity` | Get Report |
| POST | `/assessments/:assessmentId/submissions/:submissionId/signals` | 🔑 `integrity.signal.create` · 📦 `integrity` | Student emits captured CLIENT signals for their own submission. |
| POST | `/assessments/:assessmentId/submissions/:submissionId/start` | 🔑 `submission.write` · 📦 `integrity` | Start a TIMED exam — records the attempt start + returns the firm deadline. |
| POST | `/assessments/:assessmentId/submissions/:submissionId/submit` | 🔑 `submission.write` · 📦 `integrity` | Final submit, then enqueue detection. |
| GET | `/assessments/:assessmentId/take` | 🔑 `assessment.read` · 📦 `integrity` | Student take view |
| GET | `/integrity/exemptions` | 🔑 `integrity.exemption.read` | Accommodations the caller may see — own pupils for a teacher, school-wide for school_admin/principal. |
| POST | `/integrity/exemptions` | 🔑 `integrity.exemption.write` | Grant |
| DELETE | `/integrity/exemptions/:id` | 🔑 `integrity.exemption.write` | Withdraw it. |
| POST | `/integrity/retention/run` | 🔑 `integrity.retention.run` · 📦 `integrity` | Purge minors' telemetry past the retention window |
| GET | `/integrity/retention/runs` | 🔑 `integrity.retention.run` · 📦 `integrity` | Retention-run history |

---

## Attendance registers

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/attendance/by-class` | 🔑 `attendance.read` · 📦 `attendance` | Attendance BY CLASS over a window — the senior-staff overview. |
| POST | `/attendance/register-reminder/run` | 🔑 `attendance.write` · 📦 `attendance` | Remind THIS SCHOOL's class teachers about registers still outstanding today. |
| GET | `/attendance/registers` | 🔑 `attendance.read` · 📦 `attendance` | Which of the caller's classes have no register for ?date= (default today). |
| GET | `/attendance/reminder-hour` | 🔑 `attendance.read` · 📦 `attendance` | The school's own reminder hour. |
| PUT | `/attendance/reminder-hour` | 🔑 `rbac.manage` · 📦 `attendance` · ⬆️ step-up | Set Reminder Hour |
| POST | `/attendance/rollup/refresh` | 🔑 `attendance.write` · 📦 `attendance` | Roll up every ENDED term that has no rollup yet. |
| GET | `/attendance/term-lock` | 🔑 `attendance.read` · 📦 `attendance` | A class register for ?date=YYYY-MM-DD, or recent sessions if omitted. |
| GET | `/attendance/terms` | 🔑 `attendance.read` · 📦 `attendance` | The school's terms, newest first, flagged with whether each is rolled up. |
| GET | `/classes/:classId/attendance` | 🔑 `attendance.read` · 📦 `attendance` | Class register history |
| POST | `/classes/:classId/attendance` | 🔑 `attendance.write` · 📦 `attendance` | Take the daily register (auto-notifies guardians on absence) |
| GET | `/students/:studentId/attendance` | 🔑 `attendance.read` · 📦 `attendance` | A student's attendance |
| GET | `/students/:studentId/attendance/summary` | 🔑 `attendance.read` · 📦 `attendance` | A student's current-term totals (% present, absences, lates). |

---

## Boarding & hostels

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/hostels` | 🔑 `hostel.read` · 📦 `hostel` | List / create boarding houses (create: admin-only; warden sees own, head_warden sees all) |
| POST | `/hostels` | 🔑 `hostel.manage` · 📦 `hostel` | List / create boarding houses (create: admin-only; warden sees own, head_warden sees all) |
| GET | `/hostels/:hostelId/attendance` | 🔑 `hostel.read` · 📦 `hostel` | Attendance |
| POST | `/hostels/:hostelId/attendance` | 🔑 `hostel.manage` · 📦 `hostel` | Roll Call |
| PUT | `/hostels/:id` | 🔑 `hostel.manage` · 📦 `hostel` | Edit / rename a hostel (warden reassignment: admin-only) |
| DELETE | `/hostels/:id` | 🔑 `hostel.manage` · 📦 `hostel` | Delete an EMPTY hostel (admin-only; 409 while rooms exist) |
| POST | `/hostels/:id/rooms` | 🔑 `hostel.manage` · 📦 `hostel` | Create Room |
| GET | `/hostels/allocations` | 🔑 `hostel.read` · 📦 `hostel` | Room allocations (capacity check is row-locked — no over-allocation under concurrency) |
| POST | `/hostels/allocations` | 🔑 `hostel.manage` · 📦 `hostel` | Room allocations (capacity check is row-locked — no over-allocation under concurrency) |
| POST | `/hostels/allocations/:id/vacate` | 🔑 `hostel.manage` · 📦 `hostel` | Vacate a room |
| POST | `/hostels/allocations/transfer` | 🔑 `hostel.manage` · 📦 `hostel` | Move a student to another room (vacate + re-allocate, atomically). |
| GET | `/hostels/exeats` | 🔑 `hostel.read` · 📦 `hostel` | Exeats |
| POST | `/hostels/exeats` | 🔑 `hostel.manage` · 📦 `hostel` | Request Exeat |
| POST | `/hostels/exeats/:id/decide` | 🔑 `hostel.manage` · 📦 `hostel` | Decide Exeat |
| POST | `/hostels/exeats/:id/depart` | 🔑 `hostel.manage` · 📦 `hostel` | Depart Exeat |
| POST | `/hostels/exeats/:id/return` | 🔑 `hostel.manage` · 📦 `hostel` | Return Exeat |
| POST | `/hostels/exeats/overdue/run` | 🔑 `hostel.manage` · 📦 `hostel` | Run the overdue-boarder check now. |
| POST | `/hostels/fees/schedule` | 🔑 `hostel.manage` · 📦 `hostel` | Bill hostel rent — admins post directly; a (head-)warden's run becomes a FEE_SCHEDULE approval request (maker-checker) |
| GET | `/hostels/incidents` | 🔑 `hostel.read` · 📦 `hostel` | Incidents |
| POST | `/hostels/incidents` | 🔑 `hostel.manage` · 📦 `hostel` | Report Incident |
| PUT | `/hostels/incidents/:id` | 🔑 `hostel.manage` · 📦 `hostel` | Update Incident |
| PUT | `/hostels/rooms/:roomId` | 🔑 `hostel.manage` · 📦 `hostel` | Update Room |
| DELETE | `/hostels/rooms/:roomId` | 🔑 `hostel.manage` · 📦 `hostel` | Delete a room with NO allocation history (409 otherwise) |
| GET | `/hostels/summary` | 🔑 `hostel.read` · 📦 `hostel` | Occupancy analytics (warden-scoped or school-wide) |

---

## Branding

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/public/schools/:slug/branding` | 🌐 public | A school's login-page logo + theme by slug (hidden when subscription lapsed) |
| GET | `/schools/branding` | 🔑 `school.branding.manage` | Current branding |
| POST · DELETE | `/schools/branding/logo` | 🔑 `school.branding.manage` | Upload / remove the school logo (PNG/JPEG, ≤1 MB) |
| GET | `/schools/branding/me` | (auth) | ANY authenticated member of the school (no @RequirePermission — the global guard still authenticates): logo + theme for the signed-in AppShell. |
| POST | `/schools/branding/theme` | 🔑 `school.branding.manage` | Set brand colour + font |

---

## CBT exam hall

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/cbt/authoring-options` | 🔑 `cbt.manage` · 📦 `cbt` | The caller's authoring scope: their taught subjects/classes (teacher) or all (school-wide staff) — feeds the web pickers |
| GET | `/cbt/banks` | 📦 `cbt` | List question banks (teacher: own + taught-subject banks; admin: all) |
| POST | `/cbt/banks` | 🔑 `cbt.manage` · 📦 `cbt` | Create a bank — `subjectId` REQUIRED for teachers and must be a subject they teach (404 otherwise) |
| PUT | `/cbt/banks/:id` | 🔑 `cbt.manage` · 📦 `cbt` | Rename a bank, or move it to another subject (its questions go with it). |
| GET | `/cbt/banks/:id/availability` | 📦 `cbt` | What can actually be drawn for this bank + class: the resolved level, the total matching pool, and per-topic counts. |
| GET | `/cbt/banks/:id/questions` | 📦 `cbt` | Read a bank's questions. |
| POST | `/cbt/banks/:id/questions` | 🔑 `cbt.manage` · 📦 `cbt` | Add questions (typed rows from the Kahoot-style form or bulk paste; 2–6 choices, server-validated `answerIndex`) |
| GET | `/cbt/exams` | 🔑 `cbt.take` · 📦 `cbt` | Student: PUBLISHED exams open to them (class-scoped, window-live) |
| POST | `/cbt/exams` | 🔑 `cbt.manage` · 📦 `cbt` | Create an exam (DRAFT) over a bank — a teacher must target a class where they teach the bank's subject |
| GET | `/cbt/exams/:id/answer-key.pdf` | 🔑 `cbt.manage` · 📦 `cbt` | ANSWER KEY — editors only. |
| GET | `/cbt/exams/:id/integrity` | 🔑 `cbt.manage` · 📦 `cbt` | Exam Integrity |
| GET | `/cbt/exams/:id/marking` | 🔑 `cbt.manage` · 📦 `cbt` | The VERTICAL marking queue for one question: every candidate's answer. |
| GET | `/cbt/exams/:id/marking/progress` | 🔑 `cbt.manage` · 📦 `cbt` | Per-question progress + whether results are still PROVISIONAL. |
| GET | `/cbt/exams/:id/paper.pdf` | 📦 `cbt` | PRINTABLE QUESTION PAPER — no answers. |
| POST | `/cbt/exams/:id/record-grades` | 🔑 `cbt.manage` · 📦 `cbt` | ONE PRESS: record this paper's scores (Section A + Section B) into every candidate's gradesheet for the exam component. |
| POST | `/cbt/exams/:id/request-answer-release` | 🔑 `cbt.manage` · 📦 `cbt` | Maker-checker: request the answer key (only once CLOSED / window ended) → principal approves `CBT_ANSWER_RELEASE` |
| POST | `/cbt/exams/:id/request-publish` | 🔑 `cbt.manage` · 📦 `cbt` | Maker-checker: park DRAFT → PENDING_APPROVAL + raise `CBT_EXAM_PUBLISH` (approver ≠ author, engine-enforced) |
| GET | `/cbt/exams/:id/results` | 🔑 `cbt.manage` · 📦 `cbt` | Per-exam results table (names + scores; audited read) |
| POST | `/cbt/exams/:id/start` | 🔑 `cbt.take` · 📦 `cbt` | Start (or resume) the caller's sitting — server samples + fixes the question order |
| PUT | `/cbt/exams/:id/status` | 🔑 `cbt.manage` · 📦 `cbt` | Close a live exam early (`CLOSED` only — publishing goes through approval) |
| GET | `/cbt/exams/all` | 🔑 `cbt.manage` · 📦 `cbt` | Staff: every exam, all statuses |
| POST | `/cbt/marking/:answerId` | 🔑 `cbt.manage` · 📦 `cbt` | Award a mark to one answer. |
| PUT | `/cbt/questions/:id` | 🔑 `cbt.manage` · 📦 `cbt` | Correct a question. |
| DELETE | `/cbt/questions/:id` | 🔑 `cbt.manage` · 📦 `cbt` | Remove a question that no candidate has been served. |
| GET | `/cbt/sittings/:id` | 🔑 `cbt.take` · 📦 `cbt` | Own sitting view (auto-expires on read past the deadline); `answerIndex` present only when finished AND released |
| POST | `/cbt/sittings/:id/answer` | 🔑 `cbt.take` · 📦 `cbt` | Save one answer (refused after time is up — the clock is server law) |
| POST | `/cbt/sittings/:id/answer-theory` | 🔑 `cbt.take` · 📦 `cbt` | Candidate saves a THEORY answer (one row upserted, not a JSON blob). |
| POST | `/cbt/sittings/:id/integrity` | 🔑 `cbt.take` · 📦 `cbt` | Candidate's own sitting reports integrity events (left the tab, pasted). |
| POST | `/cbt/sittings/:id/submit` | 🔑 `cbt.take` · 📦 `cbt` | Submit + auto-mark (idempotent) |

---

## Certificates & ID cards

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/certificates/history/:subjectId` | 🔑 `certificate.issue` · 📦 `certificate` | Issuance history / reprint |
| POST | `/certificates/issue` | 🔑 `certificate.issue` · 📦 `certificate` | Generate an ID card / certificate PDF (**school logo embedded**) |
| POST | `/certificates/issue-class` | 🔑 `certificate.issue` · 📦 `certificate` | Register a certificate for every enrolled pupil in a class who does not already hold one of that type. |
| GET | `/certificates/verify/:serial` | 🔑 `certificate.issue` · 📦 `certificate` | Whose certificate is this serial? — the question the document itself tells its holder to put to the school, and which the product could not answer. |
| GET | `/members/scan/:code` | 🔑 `member.scan` · 📦 `certificate` | Resolve |
| POST | `/members/scan/:code` | 🔑 `member.scan` · 📦 `certificate` | RECORD an action for a scanned member (check-in / check-out / library / exam). |
| GET | `/members/scan/history/:memberId` | 🔑 `member.scan` · 📦 `certificate` | One member's movements — the answer to "when did they leave?", which the product could not give because nothing read scan_event. |
| GET | `/members/scan/today` | 🔑 `member.scan` · 📦 `certificate` | The desk's own day. |

---

## Dashboard

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/dashboard/summary` | (auth) | Summary |

---

## Discussion groups

| Method | Path | Gate | Purpose |
|---|---|---|---|
| DELETE | `/discussion/comments/:id` | 🔑 `discussion.moderate` · 📦 `discussion` | Delete Comment |
| GET | `/discussion/groups` | 🔑 `discussion.participate` · 📦 `discussion` | `discussion` | Topic groups |
| POST | `/discussion/groups` | 🔑 `discussion.moderate` · 📦 `discussion` | `discussion` | Topic groups |
| GET | `/discussion/groups/:id/posts` | 🔑 `discussion.participate` · 📦 `discussion` | `discussion` | Posts |
| POST | `/discussion/groups/:id/posts` | 🔑 `discussion.participate` · 📦 `discussion` | Post — posts |
| DELETE | `/discussion/posts/:id` | 🔑 `discussion.moderate` · 📦 `discussion` | Delete Post |
| POST | `/discussion/posts/:id/comments` | 🔑 `discussion.participate` · 📦 `discussion` | Comment |
| POST | `/discussion/posts/:id/report` | 🔑 `discussion.participate` · 📦 `discussion` | Report a post, or a comment on it, to the school's discipline process. |
| GET | `/discussion/search` | 🔑 `discussion.participate` · 📦 `discussion` | Full-text search over posts in groups the caller may see (GIN-indexed). |

---

## Document vault & supplied documents

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/documents` | 🔑 `document.read` · 📦 `documents` | List — documents |
| POST | `/documents` | 🔑 `document.write` · 📦 `documents` | Create metadata + get a presigned upload URL. |
| GET | `/documents/:id` | 🔑 `document.read` · 📦 `documents` | Get — documents |
| DELETE | `/documents/:id` | 🔑 `document.write` · 📦 `documents` | Remove a document |
| POST | `/documents/:id/confirm` | 🔑 `document.write` · 📦 `documents` | Confirm the direct upload completed. |
| GET | `/documents/:id/download` | 🔑 `document.read` · 📦 `documents` | Presigned download URL (access-checked + audited). |
| GET | `/documents/:id/file` | 🔑 `document.read` · 📦 `documents` | Stream the file bytes back through the API (access-checked + audited). |
| POST | `/documents/:id/upload-bytes` | 🔑 `document.write` · 📦 `documents` | Upload the file bytes through the API (base64) and mark the doc UPLOADED. |
| GET | `/documents/checklist` | 📦 `documents` | Checklist |
| POST | `/documents/promote` | 📦 `documents` | An accepted applicant has become a pupil — move their family's documents on to them. |
| GET | `/documents/requirements` | 📦 `documents` | List Requirements |
| POST | `/documents/requirements` | 📦 `documents` | Create Requirement |
| PUT | `/documents/requirements/:id` | 📦 `documents` | Update Requirement |
| POST | `/documents/requirements/seed-defaults` | 📦 `documents` | Adopt the platform's starting list. |
| POST | `/documents/retention/run` | 🔑 `privacy.compliance.manage` · 🔑 `platform.operate` · 📦 `documents` | Run the declined-applicant purge now. |
| POST | `/documents/submissions/:id/confirm` | 📦 `documents` | Confirm |
| POST | `/documents/submissions/:id/decide` | 📦 `documents` | Decide |
| GET | `/documents/submissions/:id/file` | 📦 `documents` | The bytes. |
| POST | `/documents/submissions/upload-url` | 📦 `documents` | Start Upload |
| POST | `/documents/submissions/waive` | 📦 `documents` | Waive |
| GET | `/local-storage/*` | 🌐 public | Get — * |
| PUT | `/local-storage/*` | 🌐 public | Put — * |
| POST | `/public/documents/:id/confirm` | 🌐 public | Confirm |
| GET | `/public/documents/checklist` | 🌐 public | Checklist |
| POST | `/public/documents/upload-url` | 🌐 public | Start Upload |

---

## Exam logistics (sittings, seating, invigilation)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/exams` | 🔑 `exam.manage` | List / schedule a sitting (hall, date, time, capacity) |
| PATCH | `/exams/:id` | 🔑 `exam.manage` | Edit a sitting IN PLACE — seats and the invigilator roster are preserved. |
| DELETE | `/exams/:id` | 🔑 `exam.manage` | Remove a sitting (cascades seats + roster) |
| GET | `/exams/:id/attendance` | 🔑 `exam.manage` | The sitting's own register: every seated student with their latest mark. `status: null` = not yet marked, which is NOT the same as absent. |
| POST | `/exams/:id/attendance` | 🔑 `exam.manage` | Mark the sitting's register. |
| GET | `/exams/:id/attendance.pdf` | 🔑 `exam.manage` | The printable hall pack: seating chart + signature column + absentee tally. |
| GET · POST | `/exams/:id/invigilators` | 🔑 `exam.manage` | Roster / assign an invigilator (staff only — a student is refused; assignee notified) |
| DELETE | `/exams/:id/invigilators/:staffId` | 🔑 `exam.manage` | Remove from the roster |
| POST | `/exams/:id/release` | 🔑 `exam.release` | Day-of RELEASE (open) an approved CBT-backed sitting — exam.release only. |
| POST | `/exams/:id/seat` | 🔑 `exam.manage` | Seat ONE sitting from its class roster. |
| GET · POST | `/exams/:id/seats` | 🔑 `exam.manage` | Seating plan / seat a student list or a whole class (seat 1..N; over capacity → 409) |
| GET | `/exams/day` | 🔑 `exam.manage` | The exam-day board: one date, grouped by hall, warnings precomputed. |
| GET | `/exams/invigilations/mine` | 🔑 `timetable.read` | The caller's own invigilation duties |
| GET | `/exams/mine` | 🔑 `timetable.read` | A student's (or their children's) upcoming exams — hall, time, **seat number** |
| GET | `/exams/schedules` | 🔑 `exam.manage` | Schedules |
| POST | `/exams/schedules` | 🔑 `exam.manage` | Create Schedule |
| POST | `/exams/schedules/:id/seat` | 🔑 `exam.manage` | Seat every unseated sitting in the schedule from its class roster, on demand. |
| POST | `/exams/schedules/:id/submit` | 🔑 `exam.manage` | Submit the whole schedule for head-teacher → principal approval. |

---

## Feedback

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/feedback` | (auth) | Send feedback. |
| POST | `/feedback/:id/reply` | (auth) | The sender replies on their OWN feedback. |
| GET | `/feedback/:id/thread` | (auth) | The sender reads the conversation on their OWN feedback (404 otherwise). |
| GET | `/feedback/mine` | (auth) | The sender's own submissions. |
| GET | `/operator/feedback` | 🔑 `platform.feedback.review` | Platform owner: the cross-tenant inbox. |
| POST | `/operator/feedback/:id/reply` | 🔑 `platform.feedback.review` | Platform owner: reply to the sender (notifies them directly). |
| POST | `/operator/feedback/:id/review` | 🔑 `platform.feedback.review` | Review |
| GET | `/operator/feedback/:id/thread` | 🔑 `platform.feedback.review` | Platform owner: read the full conversation (cross-tenant). |
| POST | `/operator/feedback/bulk-review` | 🔑 `platform.feedback.review` | Platform owner: bulk set a status on many items (up to FEEDBACK_BULK_MAX). |
| POST | `/operator/feedback/digest/run` | 🔑 `platform.feedback.review` | Platform owner: run the digest summary now (the scheduled job runs hourly). |
| GET | `/operator/feedback/stats` | 🔑 `platform.feedback.review` | Platform owner: aggregate triage counts for the inbox header. |

---

## Fees, invoices & the ledger

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/fees/adjustments/:id/decide` | 🔑 `fee.approve` · 📦 `fees` | Approve/reject an adjustment (must differ from the requester) |
| GET | `/fees/disputes` | 🔑 `fee.manage` · 📦 `fees` | List — disputes |
| GET | `/fees/disputes/:id` | 🔑 `fee.manage` · 📦 `fees` | Get — disputes |
| POST | `/fees/disputes/:id/respond` | 🔑 `fee.manage` · 📦 `fees` | Record the school's evidence response on an OPEN dispute |
| GET | `/fees/export/journal.csv` | 🔑 `fee.manage` · 📦 `fees` | Posted-payments journal CSV (formula-guarded; audited) |
| GET · POST | `/fees/items` | 🔑 `fee.manage` · 📦 `fees` | Fee catalog |
| PATCH | `/fees/items/:id` | 🔑 `fee.manage` · 📦 `fees` | Edit a fee item |
| GET | `/fees/late-fee-config` | 🔑 `fee.manage` · 📦 `fees` | Per-school automatic late-fee policy (flat + grace days) |
| PUT | `/fees/late-fee-config` | 🔑 `fee.manage` · 📦 `fees` · ⬆️ step-up | Per-school automatic late-fee policy (flat + grace days) |
| GET | `/fees/payments/pending` | 🔑 `fee.approve` · 📦 `fees` | Payments awaiting maker-checker approval |
| POST | `/fees/reconciliation/run` | 🔑 `fee.reconcile.run` · 📦 `fees` | Cross-tenant gateway reconciliation sweep (super_admin; also daily via BullMQ) |
| POST | `/fees/reminders/run` | 🔑 `fee.manage` · 📦 `fees` | Send fee reminders (also runs weekly per school, overdue-only) |
| GET | `/fees/reports` | 🔑 `fee.read` · 📦 `fees` | Receivables aging + collection |
| GET | `/fees/revenue-by-source` | 🔑 `fee.manage` · 📦 `fees` | What each part of the school brought in — hostel, transport, library and academic fees, separated, per currency. `fee.manage`, like the finance report it sits beside: this is revenue by department, not a family's own… |
| GET | `/fees/settlement` | 🔑 `fee.manage` · 📦 `fees` | The school's fee-settlement posture (bank display fields, never the full account number). |
| PUT | `/fees/settlement` | 🔑 `fee.manage` · 📦 `fees` · ⬆️ step-up | Set the school's settlement bank (creates the Paystack subaccount; every fee charge then splits to the school's own account). |
| GET | `/fees/settlement/banks` | 🔑 `fee.manage` · 📦 `fees` | Banks the gateway can settle to, for the settlement picker. |
| PUT | `/fees/settlement/fee-bearer` | 🔑 `fee.manage` · 📦 `fees` · ⬆️ step-up | Choose who bears the platform's online-payment convenience fee for this school: PARENT (payer pays invoice + fee) or SCHOOL (fee comes out of settlement). |
| POST | `/fees/settlement/resolve` | 🔑 `fee.manage` · 📦 `fees` | Read back whose account a bank + NUBAN actually is, BEFORE saving it. |
| GET | `/invoices` | 🔑 `fee.read` · 📦 `fees` | Invoices, filtered and paged. `q` matches the reference — how staff actually look one up when a parent quotes it off their copy. |
| POST | `/invoices` | 🔑 `fee.manage` · 📦 `fees` | Create an invoice |
| GET | `/invoices/:id` | 🔑 `fee.read` · 📦 `fees` | Get Invoice |
| GET · POST | `/invoices/:id/adjustments` | 🔑 `fee.manage` · 📦 `fees` | List / request a discount-waiver (maker-checker) |
| POST | `/invoices/:id/apply-credit` | 🔑 `fee.manage` · 📦 `fees` | Apply credit balance to an invoice (APPLIED entry + POSTED CREDIT payment) |
| POST | `/invoices/:id/cancel` | 🔑 `fee.manage` · 📦 `fees` | Cancel an invoice |
| POST | `/invoices/:id/issue` | 🔑 `fee.manage` · 📦 `fees` | Issue a DRAFT invoice |
| POST | `/invoices/:id/overpayment-to-credit` | 🔑 `fee.manage` · 📦 `fees` | Move overpaid excess to credit (double-entry: system REFUND + OVERPAYMENT) |
| GET | `/invoices/:id/pay/availability` | 🔑 `fee.read` · 📦 `fees` | PRE-FLIGHT: can this invoice be paid online right now? |
| POST | `/invoices/:id/pay/confirm` | 🔑 `fee.read` · 📦 `fees` | Verify-on-return: confirm a charge against the gateway if the webhook was lost (idempotent) |
| POST | `/invoices/:id/pay/init` | 🔑 `fee.read` · 📦 `fees` | Start hosted checkout — Paystack (NGN) or Stripe (USD invoices) |
| GET | `/invoices/:id/payments` | 🔑 `fee.read` · 📦 `fees` | Record / list payments |
| POST | `/invoices/:id/payments` | 🔑 `fee.manage` · 📦 `fees` | Record / list payments |
| GET | `/invoices/:id/plan` | 🔑 `fee.read` · 📦 `fees` | Installment plan (tranches must sum to total; states derived from payments) |
| PUT | `/invoices/:id/plan` | 🔑 `fee.manage` · 📦 `fees` | Installment plan (tranches must sum to total; states derived from payments) |
| POST | `/invoices/issue-bulk` | 🔑 `fee.manage` · 📦 `fees` | Issue many drafts at once — the batch end of a fee run. |
| GET | `/invoices/summary` | 🔑 `fee.read` · 📦 `fees` | Outstanding / collected / overdue over the caller's VISIBLE set — one SQL aggregate, never a sum of the page currently on screen. |
| POST | `/payments/:id/approve` | 🔑 `fee.approve` · 📦 `fees` | Approve Payment |
| GET | `/payments/:id/receipt.pdf` | 🔑 `fee.read` · 📦 `fees` | Numbered receipt PDF for a POSTED payment (family/staff scoped, audited) |
| POST | `/payments/:id/reject` | 🔑 `fee.approve` · 📦 `fees` | Reject Payment |
| POST | `/payments/webhook` | 🌐 public · 📦 `fees` | Paystack webhook (HMAC-SHA512 verified; logs to `gateway_event`, dispatches disputes / subscription / admission / credits / prepay / dedicated-NUBAN / invoice) |
| GET | `/students/:id/credit` | 🔑 `fee.read` · 📦 `fees` | Student credit balance + append-only ledger (self/guardian/staff) |
| POST | `/students/:id/prepay/init` | 🔑 `fee.read` · 📦 `fees` | Prepay into the credit balance (hosted checkout) |
| GET | `/students/:id/virtual-account` | 🔑 `fee.read` · 📦 `fees` | Read / provision a dedicated NUBAN (transfers auto-credit the oldest open invoice) |
| POST | `/students/:id/virtual-account` | 🔑 `fee.manage` · 📦 `fees` | Read / provision a dedicated NUBAN (transfers auto-credit the oldest open invoice) |

---

## Forms

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/forms` | 🔑 `form.respond` · 📦 `form` | `form` | List / create forms |
| POST | `/forms` | 🔑 `form.manage` · 📦 `form` | `form` | List / create forms |
| POST | `/forms/:id/close` | 🔑 `form.manage` · 📦 `form` | Close |
| POST | `/forms/:id/respond` | 🔑 `form.respond` · 📦 `form` | Respond |
| GET | `/forms/:id/responses` | 🔑 `form.manage` · 📦 `form` | `form` | Tallies (anonymous) |

---

## Games & competitions

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/checkers` | 🔑 `game.leaderboard.read` · 📦 `games` | List — checkers |
| POST | `/checkers` | 🔑 `game.play` · 📦 `games` | Create — checkers |
| GET | `/checkers/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — checkers |
| POST | `/checkers/:id/claim-time` | 🔑 `game.play` · 📦 `games` | Claim Time |
| POST | `/checkers/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/checkers/:id/move` | 🔑 `game.play` · 📦 `games` | Move |
| POST | `/checkers/:id/resign` | 🔑 `game.play` · 📦 `games` | Resign |
| GET | `/chess` | 🔑 `game.leaderboard.read` · 📦 `games` | List — chess |
| POST | `/chess` | 🔑 `game.play` · 📦 `games` | Create — chess |
| GET | `/chess/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — chess |
| POST | `/chess/:id/claim-time` | 🔑 `game.play` · 📦 `games` | Claim Time |
| POST | `/chess/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/chess/:id/move` | 🔑 `game.play` · 📦 `games` | Move |
| POST | `/chess/:id/resign` | 🔑 `game.play` · 📦 `games` | Resign |
| GET | `/competitions` | 🔑 `game.leaderboard.read` · 📦 `games` | List — competitions |
| POST | `/competitions` | 🔑 `game.league.create` · 📦 `games` | Create — competitions |
| GET | `/competitions/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — competitions |
| POST | `/competitions/:id/cancel` | 🔑 `game.league.create` · 📦 `games` | Cancel |
| POST | `/competitions/:id/start` | 🔑 `game.league.create` · 📦 `games` | Start |
| POST | `/competitions/:id/sweep` | 🔑 `game.league.create` · 📦 `games` | Sweep |
| GET | `/game-settings` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — game settings |
| PUT | `/game-settings` | 🔑 `game.settings.manage` · 📦 `games` | Update — game settings |
| POST | `/games` | 🔑 `game.play` · 📦 `games` | Create — games |
| GET | `/games/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — games |
| POST | `/games/:id/end` | 🔑 `game.match.moderate` · 📦 `games` | Moderator force-end of a stuck/abusive duel — ends with no winner. |
| POST | `/games/:id/forfeit` | 🔑 `game.play` · 📦 `games` | Forfeit |
| POST | `/games/:id/guess` | 🔑 `game.play` · 📦 `games` | Guess |
| POST | `/games/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/games/:id/secret` | 🔑 `game.play` · 📦 `games` | Secret |
| GET | `/games/open` | 🔑 `game.play` · 📦 `games` | List Open |
| GET | `/hangman` | 🔑 `game.leaderboard.read` · 📦 `games` | List — hangman |
| POST | `/hangman` | 🔑 `game.hangman.host` · 📦 `games` | Open |
| GET | `/hangman/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — hangman |
| POST | `/hangman/:id/end` | 🔑 `game.hangman.host` · 📦 `games` | End |
| POST | `/hangman/:id/guess` | 🔑 `game.play` · 📦 `games` | Guess |
| POST | `/hangman/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/hangman/:id/start` | 🔑 `game.hangman.host` · 📦 `games` | Start |
| GET | `/quiz-sessions` | 🔑 `game.leaderboard.read` · 📦 `games` | List Sessions |
| POST | `/quiz-sessions` | 🔑 `game.quiz.host` · 📦 `games` | Open |
| GET | `/quiz-sessions/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get Session |
| POST | `/quiz-sessions/:id/answer` | 🔑 `game.play` · 📦 `games` | Answer |
| POST | `/quiz-sessions/:id/end` | 🔑 `game.quiz.host` · 📦 `games` | End |
| POST | `/quiz-sessions/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/quiz-sessions/:id/next` | 🔑 `game.quiz.host` · 📦 `games` | Next |
| GET | `/quizzes` | 🔑 `game.quiz.host` · 📦 `games` | List — quizzes |
| POST | `/quizzes` | 🔑 `game.quiz.host` · 📦 `games` | Create — quizzes |
| GET | `/quizzes/:id` | 🔑 `game.quiz.host` · 📦 `games` | Get — quizzes |
| PUT | `/quizzes/:id` | 🔑 `game.quiz.host` · 📦 `games` | Update — quizzes |
| DELETE | `/quizzes/:id` | 🔑 `game.quiz.host` · 📦 `games` | Remove — quizzes |
| POST | `/race-tournaments` | 🔑 `game.race.tournament` · 📦 `games` | Open Tournament |
| GET | `/race-tournaments/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get Tournament |
| GET | `/races` | 🔑 `game.leaderboard.read` · 📦 `games` | List — races |
| POST | `/races` | 🔑 `game.race.open` · 📦 `games` | Open |
| GET | `/races/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — races |
| POST | `/races/:id/end` | 🔑 `game.race.open` · 📦 `games` | End |
| POST | `/races/:id/guess` | 🔑 `game.play` · 📦 `games` | Guess |
| POST | `/races/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/races/:id/start` | 🔑 `game.race.open` · 📦 `games` | Start |
| POST | `/rings` | 🔑 `game.play` · 📦 `games` | Open |
| GET | `/rings/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — rings |
| POST | `/rings/:id/end` | 🔑 `game.match.moderate` · 📦 `games` | End |
| POST | `/rings/:id/forfeit` | 🔑 `game.play` · 📦 `games` | Forfeit |
| POST | `/rings/:id/guess` | 🔑 `game.play` · 📦 `games` | Guess |
| POST | `/rings/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/rings/:id/secret` | 🔑 `game.play` · 📦 `games` | Secret |
| POST | `/rings/:id/start` | 🔑 `game.play` · 📦 `games` | Start |
| POST | `/rings/:id/timeout` | 🔑 `game.play` · 📦 `games` | Timeout |
| GET | `/typing-races` | 🔑 `game.leaderboard.read` · 📦 `games` | List — typing races |
| POST | `/typing-races` | 🔑 `game.typing.host` · 📦 `games` | Open |
| GET | `/typing-races/:id` | 🔑 `game.leaderboard.read` · 📦 `games` | Get — typing races |
| POST | `/typing-races/:id/end` | 🔑 `game.typing.host` · 📦 `games` | End |
| POST | `/typing-races/:id/join` | 🔑 `game.play` · 📦 `games` | Join |
| POST | `/typing-races/:id/progress` | 🔑 `game.play` · 📦 `games` | Progress |
| POST | `/typing-races/:id/start` | 🔑 `game.typing.host` · 📦 `games` | Start |
| GET | `/ultimate/competitions` | 🔑 `game.leaderboard.read` · 📦 `games` | List — competitions |
| POST | `/ultimate/competitions` | 🔑 `game.ultimate.admin` · 📦 `games` | Create — competitions |
| POST | `/ultimate/competitions/:id/cancel` | 🔑 `game.ultimate.admin` · 📦 `games` | Cancel |
| POST | `/ultimate/competitions/:id/enroll` | 🔑 `game.ultimate.enroll` · 📦 `games` | Enroll |
| POST | `/ultimate/competitions/:id/enter` | 🔑 `game.play` · 📦 `games` | Enter |
| POST | `/ultimate/competitions/:id/guess` | 🔑 `game.play` · 📦 `games` | Guess |
| GET | `/ultimate/competitions/:id/leaderboard` | 🔑 `game.leaderboard.read` · 📦 `games` | Leaderboard |
| GET | `/ultimate/competitions/:id/me` | 🔑 `game.play` · 📦 `games` | Me |
| PUT | `/ultimate/consent` | 🔑 `game.ultimate.consent` · 📦 `games` | Consent |

---

## Global search

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/search` | (auth) | Run |

---

## Gradebook & marks

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/grades/mine` | 🔑 `grade.read` · 📦 `gradebook` | Student/parent own-grade view |
| GET | `/subject-selections` | 🔑 `grade.read` · 📦 `gradebook` | `?filter=open` is the review queue (oldest first); `?filter=decided` the history. `pendingTotal` on the response is school-wide within the caller's scope and is never narrowed by the filter. |
| POST | `/subject-selections` | 🔑 `subject.select` · 📦 `gradebook` | Student submits (or resubmits a rejected) term subject selection. |
| POST | `/subject-selections/:id/review` | 🔑 `class.read` · 📦 `gradebook` | Stage review. |
| GET | `/subject-selections/options` | 🔑 `subject.select` · 📦 `gradebook` | Student: the current term, the subjects fixed on my class, my selection. |
| GET | `/submissions/:submissionId/grade` | 🔑 `grade.read` · 📦 `gradebook` | Read a grade |
| POST | `/submissions/:submissionId/grade` | 🔑 `grade.write` · 📦 `gradebook` | Record/publish a grade |
| POST | `/term-results` | 🔑 `grade.write` · 📦 `gradebook` | Enter/update a student's four component scores for a subject+term. |
| GET | `/term-results/analytics` | 🔑 `grade.read` · 📦 `gradebook` | How each class-subject performed this term. |
| GET | `/term-results/broadsheet` | 🔑 `grade.read` · 📦 `gradebook` | Class broadsheet: the whole-class score sheet for a term (every student × every subject). |
| POST | `/term-results/publish` | 🔑 `grade.write` · 📦 `gradebook` | Request publication of a class-subject-term's draft results. |
| GET | `/term-results/report/:studentId/:sessionId` | 🔑 `grade.read` · 📦 `gradebook` | A student's whole-session report card (3 terms). |
| GET | `/term-results/report/:studentId/:sessionId/:termId/pdf` | 🔑 `grade.read` · 📦 `gradebook` | Download ONE term's scoresheet as a PDF. |
| GET | `/term-results/report/:studentId/:sessionId/session-pdf` | 🔑 `grade.read` · 📦 `gradebook` | Download the whole SESSION (cumulative) report as a PDF — every term plus the per-subject session average. |
| GET | `/term-results/roster` | 🔑 `grade.write` · 📦 `gradebook` | Subject-teacher roster: students offering a subject in a class for a term, with their current component scores. |

---

## Health

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/health` | 🌐 public | Liveness/readiness probe |

---

## HR, payroll & staff lifecycle

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/hr/analytics` | 🔑 `hr.read` · 📦 `hr` | HR dashboard (headcount, leave, cost, expiries) |
| GET | `/hr/appraisals` | 🔑 `hr.appraisal.manage` · 📦 `hr` | List Appraisals |
| PUT | `/hr/appraisals/:id` | 🔑 `hr.appraisal.manage` · 📦 `hr` | Update Appraisal |
| POST | `/hr/appraisals/:id/acknowledge` | 🔑 `hr.self` · 📦 `hr` | Appraisee self-acknowledges |
| POST | `/hr/appraisals/:id/submit` | 🔑 `hr.appraisal.manage` · 📦 `hr` | Submit Appraisal |
| GET | `/hr/appraisals/me` | 🔑 `hr.self` · 📦 `hr` | My Appraisals |
| POST | `/hr/attendance/clock-in` | 🔑 `hr.self` · 📦 `hr` | Staff clock-in with the current display code (hr.self). |
| GET | `/hr/attendance/devices` | 🔑 `hr.read` · 📦 `hr` | List Devices |
| POST | `/hr/attendance/devices` | 🔑 `hr.write` · 📦 `hr` | Register a terminal — the HMAC secret is returned ONCE. |
| DELETE | `/hr/attendance/devices/:id` | 🔑 `hr.write` · 📦 `hr` | Remove Device |
| GET | `/hr/attendance/enrollments` | 🔑 `hr.read` · 📦 `hr` | List Enrollments |
| POST | `/hr/attendance/enrollments` | 🔑 `hr.write` · 📦 `hr` | Enroll |
| DELETE | `/hr/attendance/enrollments/:id` | 🔑 `hr.write` · 📦 `hr` | Unenroll |
| GET | `/hr/attendance/kiosk` | 🔑 `hr.read` · 📦 `hr` | Kiosk Config |
| PUT | `/hr/attendance/kiosk` | 🔑 `hr.write` · 📦 `hr` | Update Kiosk |
| GET | `/hr/attendance/kiosk/code` | 🔑 `hr.read` · 📦 `hr` | The rotating gate-display code (staff-operated screen; hr.read). |
| POST | `/hr/attendance/mark` | 🔑 `hr.write` · 📦 `hr` | Mark |
| GET | `/hr/attendance/me` | 🔑 `hr.self` · 📦 `hr` | My History |
| GET | `/hr/attendance/register/:date` | 🔑 `hr.read` · 📦 `hr` | Register |
| GET | `/hr/attendance/summary` | 🔑 `hr.read` · 📦 `hr` | Both optional — omitted means the school's current month. |
| DELETE | `/hr/components/:id` | 🔑 `hr.write` · 📦 `hr` | Remove Component |
| GET | `/hr/disciplinary` | 🔑 `hr.disciplinary.manage` · 📦 `hr` | Disciplinary cases |
| POST | `/hr/disciplinary/:id/entries` | 🔑 `hr.disciplinary.manage` · 📦 `hr` | Add Entry |
| POST | `/hr/disciplinary/:id/status` | 🔑 `hr.disciplinary.manage` · 📦 `hr` | Set Status |
| GET | `/hr/duty` | 🔑 `hr.read` · 📦 `hr` | List — duty |
| POST | `/hr/duty` | 🔑 `hr.write` · 📦 `hr` | Assign |
| DELETE | `/hr/duty/:id` | 🔑 `hr.write` · 📦 `hr` | Remove — duty |
| GET | `/hr/duty/me` | 🔑 `hr.self` · 📦 `hr` | Mine |
| GET | `/hr/employees` | 🔑 `hr.read` · 📦 `hr` | Directory (list) |
| GET | `/hr/employees/:userId` | 🔑 `hr.read` · 📦 `hr` | Employment record (salary encrypted; reads audited) |
| PUT | `/hr/employees/:userId` | 🔑 `hr.write` · 📦 `hr` | Employment record (salary encrypted; reads audited) |
| GET | `/hr/employees/:userId/components` | 🔑 `hr.read` · 📦 `hr` | List Components |
| POST | `/hr/employees/:userId/components` | 🔑 `hr.write` · 📦 `hr` | Add Component |
| GET | `/hr/employment/changes` | 🔑 `hr.read` · 📦 `hr` | List — changes |
| POST | `/hr/employment/changes` | 🔑 `hr.write` · 📦 `hr` | Maker (hr.write). |
| POST | `/hr/employment/changes/:id/decide` | 🔑 `hr.salary.approve` · 📦 `hr` | Checker (hr.salary.approve; ≠ requester — enforced in the service). |
| GET | `/hr/exits` | 🔑 `hr.read` · 📦 `hr` | List — exits |
| POST | `/hr/exits` | 🔑 `hr.write` · 📦 `hr` | Initiate |
| POST | `/hr/exits/:id/decide` | 🔑 `hr.salary.approve` · 📦 `hr` · ⬆️ step-up | Settlement moves money → step-up, and the initiator can never decide. |
| POST | `/hr/exits/revoke-elapsed` | 🔑 `hr.write` · 📦 `hr` | Close the access of anyone whose last working day has passed. |
| GET | `/hr/leave/balances/me` | 🔑 `hr.self` · 📦 `hr` | My Balances |
| GET | `/hr/leave/calendar` | 📦 `hr` | WHO ELSE IS ALREADY OUT — and therefore reachable by the people who DECIDE leave, not only by the one who administers it. `STAFF_REQUEST_CHAIN` routes every leave request through head of teaching -> HR manager -> prin… |
| GET | `/hr/leave/requests` | 🔑 `hr.leave.manage` · 📦 `hr` | The school's leave register: filtered, searchable, paged. |
| POST | `/hr/leave/requests` | 🔑 `hr.self` · 📦 `hr` | Apply for leave (routes through the workflow) |
| GET | `/hr/leave/requests/me` | 🔑 `hr.self` · 📦 `hr` | My Requests |
| GET | `/hr/leave/types` | 🔑 `hr.self` · 📦 `hr` | List Types |
| POST | `/hr/leave/types` | 🔑 `hr.leave.manage` · 📦 `hr` | (setup) create a leave type |
| PUT | `/hr/leave/types/:id` | 🔑 `hr.leave.manage` · 📦 `hr` | Correct a leave type, or retire one. |
| GET | `/hr/letters/:userId/pdf` | 🔑 `hr.write` · 📦 `hr` | Letter |
| GET | `/hr/loans` | 🔑 `hr.read` · 📦 `hr` | List Loans |
| POST | `/hr/loans` | 🔑 `hr.self` · 📦 `hr` | Staff self-request (maker). |
| POST | `/hr/loans/:id/decide` | 🔑 `hr.salary.approve` · 📦 `hr` · ⬆️ step-up | Checker decides (≠ requester, enforced in the service). |
| GET | `/hr/loans/me` | 🔑 `hr.self` · 📦 `hr` | My Loans |
| GET · PUT | `/hr/me` | 🔑 `hr.self` · 📦 `hr` | Staff self-service profile (encrypted personal/bank fields) |
| POST | `/hr/me/erase-personal` | 🔑 `hr.self` · 📦 `hr` | Erase self-service fields (retain statutory record) |
| GET | `/hr/me/export` | 🔑 `hr.self` · 📦 `hr` | Staff NDPR data export |
| GET | `/hr/org` | 🔑 `hr.read` · 📦 `hr` | Org |
| GET | `/hr/payroll/me/payslips` | 🔑 `hr.self` · 📦 `hr` | My Payslips |
| GET | `/hr/payroll/me/payslips/:runId/pdf` | 🔑 `hr.self` · 📦 `hr` | My Payslip Pdf |
| GET | `/hr/payroll/remittance-schedules` | 🔑 `hr.payroll.run` · 📦 `hr` | Which statutory schedules THIS school files, from its country pack. |
| GET | `/hr/payroll/runs` | 🔑 `hr.read` · 📦 `hr` | List — runs |
| POST | `/hr/payroll/runs` | 🔑 `hr.payroll.run` · 📦 `hr` | Start a payroll run (snapshots salaries) |
| GET | `/hr/payroll/runs/:id` | 🔑 `hr.read` · 📦 `hr` | Get — runs |
| GET | `/hr/payroll/runs/:id/bank-export` | 🔑 `hr.payroll.run` · 📦 `hr` | Bank-transfer CSV |
| POST | `/hr/payroll/runs/:id/finalize` | 🔑 `hr.payroll.run` · 📦 `hr` | Finalize a run (maker-checker: creator ≠ finalizer) |
| GET | `/hr/payroll/runs/:id/payslips/:userId/pdf` | 🔑 `hr.read` · 📦 `hr` | Payslip PDF |
| GET | `/hr/payroll/runs/:id/remittance` | 🔑 `hr.payroll.run` · 📦 `hr` | Statutory remittance schedule (CSV). |
| GET | `/hr/recruitment/applicants` | 🔑 `hr.recruit.manage` · 📦 `hr` | Applicant pipeline |
| POST | `/hr/recruitment/applicants/:id/convert` | 🔑 `hr.recruit.manage` · 📦 `hr` · ⬆️ step-up | Convert applicant → User + Employee |
| GET | `/hr/recruitment/applicants/:id/cv` | 🔑 `hr.recruit.manage` · 📦 `hr` | Download an applicant's CV (PII — audited server-side). |
| POST | `/hr/recruitment/applicants/:id/stage` | 🔑 `hr.recruit.manage` · 📦 `hr` | Advance an applicant |
| GET | `/hr/recruitment/requisitions` | 🔑 `hr.recruit.manage` · 📦 `hr` | Requisitions |
| POST | `/hr/recruitment/requisitions` | 🔑 `hr.recruit.manage` · 📦 `hr` | Job requisitions |
| POST | `/hr/recruitment/requisitions/:id/applicants` | 🔑 `hr.recruit.manage` · 📦 `hr` | Add Applicant |
| POST | `/hr/recruitment/requisitions/:id/status` | 🔑 `hr.recruit.manage` · 📦 `hr` | Set Req Status |
| GET | `/hr/salary/changes` | 🔑 `hr.read` · 📦 `hr` | Salary-change history |
| POST | `/hr/salary/changes/:id/decide` | 🔑 `hr.salary.approve` · 📦 `hr` · ⬆️ step-up | Approve/reject (different person) |
| POST | `/hr/salary/employees/:employeeId/changes` | 🔑 `hr.salary.request` · 📦 `hr` · ⬆️ step-up | Request a salary change |
| POST | `/hr/staff/:userId/appraisals` | 🔑 `hr.appraisal.manage` · 📦 `hr` | Create Appraisal |
| POST | `/hr/staff/:userId/checklists` | 🔑 `hr.write` · 📦 `hr` | On/offboarding checklists |
| POST | `/hr/staff/:userId/disciplinary` | 🔑 `hr.disciplinary.manage` · 📦 `hr` | Open a disciplinary case |
| POST | `/hr/staff/:userId/documents` | 🔑 `hr.write` · 📦 `hr` | Staff documents (with expiry) |
| GET | `/hr/staff/:userId/handover` | 🔑 `hr.read` · 📦 `hr` | What this person still holds — classes, cover, invigilation, open tasks. |
| POST | `/hr/staff/:userId/training` | 🔑 `hr.write` · 📦 `hr` | Training records |
| POST | `/hr/staff/checklist-items/:itemId/toggle` | 🔑 `hr.write` · 📦 `hr` | Toggle a checklist task |
| GET | `/hr/staff/checklists` | 🔑 `hr.read` · 📦 `hr` | Checklists |
| GET | `/hr/staff/documents` | 🔑 `hr.read` · 📦 `hr` | Documents |
| POST | `/hr/staff/documents/reminders/run` | 🔑 `hr.write` · 📦 `hr` | Doc-expiry reminder sweep |
| GET | `/hr/staff/training` | 🔑 `hr.read` · 📦 `hr` | Training records |
| POST | `/public/biometric/:slug/events` | 🌐 public · 📦 `hr` | Ingest |
| GET | `/public/careers` | 🌐 public · 📦 `hr` | The index: only schools with an open vacancy, and how many. |
| GET | `/public/careers/:slug` | 🌐 public · 📦 `hr` | Openings |
| POST | `/public/careers/:slug/apply` | 🌐 public · 📦 `hr` | File Interceptor |

---

## Learning management (classes, enrolment, content)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/academic/advance-term` | 🔑 `academic.manage` · 📦 `lms` | One-click advance to the next term (or the next session's first term). |
| GET | `/academic/grading-policy` | 🔑 `class.read` · 📦 `lms` | The school's grading policy plus every choice available. |
| PUT | `/academic/grading-policy` | 🔑 `academic.manage` · 📦 `lms` | Set the letter scale and/or the component weights. |
| GET | `/academic/health` | 🔑 `class.read` · 📦 `lms` | Calendar Health |
| GET | `/academic/holidays` | 🔑 `class.read` · 📦 `lms` | Holidays |
| POST | `/academic/holidays` | 🔑 `academic.manage` · 📦 `lms` | Create Holiday |
| DELETE | `/academic/holidays/:id` | 🔑 `academic.manage` · 📦 `lms` | Delete Holiday |
| POST | `/academic/progression/run` | 🔑 `platform.operate` | Run the auto-progression sweep across all tenants now (platform operator). |
| GET | `/academic/sessions` | 🔑 `class.read` · 📦 `lms` | Academic sessions |
| POST | `/academic/sessions` | 🔑 `academic.manage` · 📦 `lms` | Create a session |
| PUT | `/academic/sessions/:id` | 🔑 `class.write` · 📦 `lms` | Correct a session's name or window. |
| DELETE | `/academic/sessions/:id` | 🔑 `class.write` · 📦 `lms` | Remove a session added by mistake. |
| PUT | `/academic/sessions/:id/current` | 🔑 `academic.manage` · 📦 `lms` | Set current session |
| POST | `/academic/sessions/:id/terms` | 🔑 `academic.manage` · 📦 `lms` | Add a term |
| POST | `/academic/sessions/standard` | 🔑 `academic.manage` · 📦 `lms` | Quick-create a standard 3-term session with dated terms. |
| GET | `/academic/shape` | 🔑 `class.read` · 📦 `lms` | The school's year shape — drives the term-name choices and the quick-create. |
| POST | `/academic/sync-current` | 🔑 `academic.manage` · 📦 `lms` | Set the current term (and session) to the one whose dates contain today. |
| PUT | `/academic/terms/:id` | 🔑 `academic.manage` · 📦 `lms` | Edit a term's name/sequence/dates. |
| DELETE | `/academic/terms/:id` | 🔑 `class.write` · 📦 `lms` | Remove a term added by mistake. |
| PUT | `/academic/terms/:id/current` | 🔑 `academic.manage` · 📦 `lms` | Set current term |
| POST | `/attempts/:id/grade-essays` | 🔑 `lms.content.write` · 📦 `lms` | Grade Quiz Essays |
| DELETE | `/awards/:id` | 🔑 `lms.content.write` · 📦 `lms` | Revoke Award |
| POST | `/classes` | 🔑 `class.write` · 📦 `lms` | Create a class |
| GET | `/classes/:classId` | 🔑 `enrollment.read` · 📦 `lms` | Class detail (admin) |
| PUT | `/classes/:classId` | 🔑 `class.write` · 📦 `lms` | Edit a class (level / next-class / supervisor) |
| DELETE | `/classes/:classId` | 🔑 `class.write` · 📦 `lms` | Delete a class — only while EMPTY (e.g. a duplicate created in error) |
| GET | `/classes/:classId/analytics` | 🔑 `lms.content.read` · 📦 `lms` | Analytics |
| GET | `/classes/:classId/awards` | 🔑 `lms.content.read` · 📦 `lms` | List Awards |
| POST | `/classes/:classId/awards` | 🔑 `lms.content.write` · 📦 `lms` | Award Badge |
| GET | `/classes/:classId/content` | 🔑 `lms.content.read` · 📦 `lms` | List class content |
| POST | `/classes/:classId/content` | 🔑 `lms.content.write` · 📦 `lms` | Create learning content |
| GET | `/classes/:classId/eligibility` | 🔑 `enrollment.read` · 📦 `lms` | Who may be enrolled |
| POST | `/classes/:classId/enrollments` | 🔑 `enrollment.write` · 📦 `lms` | Enroll students |
| PUT | `/classes/:classId/enrollments/:studentId/status` | 🔑 `enrollment.write` · 📦 `lms` | Transfer / withdraw / graduate an enrollment |
| POST | `/classes/:classId/enrollments/bulk` | 🔑 `enrollment.write` · 📦 `lms` | Enrol MANY students at once — one capacity check, already-enrolled skipped. |
| GET | `/classes/:classId/info` | 🔑 `class.read` · 📦 `lms` | Class membership summary |
| GET | `/classes/:classId/live` | 🔑 `lms.content.read` · 📦 `lms` | List Live |
| POST | `/classes/:classId/live` | 🔑 `lms.content.write` · 📦 `lms` | Create Live |
| GET | `/classes/:classId/lms-grades` | 🔑 `grade.write` · 📦 `lms` | Aggregated LMS scores for a (class, subject, term) — signals for the teacher; nothing is written until they apply. |
| POST | `/classes/:classId/lms-grades/apply` | 🔑 `grade.write` · 📦 `lms` | Apply the suggested CA marks into the report card (DRAFT, merged); the teacher then publishes via the normal maker-checker chain. |
| GET | `/classes/:classId/modules` | 🔑 `lms.content.read` · 📦 `lms` | List Modules |
| POST | `/classes/:classId/modules` | 🔑 `lms.content.write` · 📦 `lms` | Create Module |
| GET | `/classes/:classId/progress` | 🔑 `lms.content.read` · 📦 `lms` | Class Progress |
| GET | `/classes/:classId/roster.csv` | 🔑 `enrollment.read` · 📦 `lms` | Roster CSV export |
| GET | `/classes/:classId/subjects` | 🔑 `class.read` · 📦 `lms` | List a class's subject-teacher offerings |
| POST | `/classes/:classId/subjects` | 🔑 `subject.manage` · 📦 `lms` | Assign a teacher to a class-subject |
| DELETE | `/classes/:classId/subjects/:subjectId` | 🔑 `subject.manage` · 📦 `lms` | Remove a subject offering from a class |
| POST | `/classes/:classId/subjects/bulk` | 🔑 `subject.manage` · 📦 `lms` | Assign MANY subjects to a class at once (all-or-nothing, upserts). |
| POST | `/classes/:classId/subjects/copy-to-arms` | 🔑 `class.write` · 📦 `lms` | Copy this class's subject set onto every other arm of the same stream — one action instead of one configuration per arm. |
| POST | `/classes/:classId/teachers` | 🔑 `enrollment.write` · 📦 `lms` | Assign a teacher to a class |
| DELETE | `/classes/:classId/teachers/:teacherId` | 🔑 `enrollment.write` · 📦 `lms` | Take a class teacher off a class — the counterpart the assign route never had, so class-wide access could be granted and never revoked. |
| GET | `/classes/mine` | 🔑 `class.read` · 📦 `lms` | The caller's relationship-scoped classes |
| GET | `/classes/overview` | 🔑 `class.read` · 📦 `lms` | The caller's classes with roll / capacity / supervisor / teaching counts — what the classes page is actually managed by. |
| GET | `/content/:id` | 🔑 `lms.content.read` · 📦 `lms` | Content detail (reviewer) |
| PUT | `/content/:id` | 🔑 `lms.content.write` · 📦 `lms` | Edit content |
| GET | `/content/:id/attempts` | 🔑 `lms.content.write` · 📦 `lms` | List Quiz Attempts |
| POST | `/content/:id/clone` | 🔑 `lms.content.write` · 📦 `lms` | Clone |
| POST | `/content/:id/complete` | 🔑 `lms.content.read` · 📦 `lms` | Mark Complete |
| DELETE | `/content/:id/complete` | 🔑 `lms.content.read` · 📦 `lms` | Unmark Complete |
| GET | `/content/:id/download` | 🔑 `lms.content.read` · 📦 `lms` | Download attachment |
| GET | `/content/:id/forum` | 🔑 `lms.content.read` · 📦 `lms` | Course forum |
| POST | `/content/:id/forum` | 🔑 `lms.forum.post` · 📦 `lms` | Course forum |
| PUT | `/content/:id/module` | 🔑 `lms.content.write` · 📦 `lms` | Assign Module |
| POST | `/content/:id/quiz/attempt` | 🔑 `lms.quiz.attempt` · 📦 `lms` | Attempt a quiz |
| GET | `/content/:id/quiz/me` | 🔑 `lms.content.read` · 📦 `lms` | Own quiz results |
| POST | `/content/:id/revert/:revisionId` | 🔑 `lms.content.write` · 📦 `lms` | Revert |
| POST | `/content/:id/review` | 🔑 `lms.content.approve` · 📦 `lms` | Approve/reject content |
| GET | `/content/:id/revisions` | 🔑 `lms.content.write` · 📦 `lms` | Revisions |
| POST | `/content/:id/submission` | 🔑 `lms.content.read` · 📦 `lms` | Submit Assignment |
| GET | `/content/:id/submission/me` | 🔑 `lms.content.read` · 📦 `lms` | My Submission |
| GET | `/content/:id/submissions` | 🔑 `lms.content.read` · 📦 `lms` | List Submissions |
| POST | `/content/:id/submit` | 🔑 `lms.content.write` · 📦 `lms` | Submit content for approval |
| POST | `/content/:id/upload` | 🔑 `lms.content.write` · 📦 `lms` | Upload |
| POST | `/content/:id/upload/confirm` | 🔑 `lms.content.write` · 📦 `lms` | Confirm |
| GET | `/content/approvals/pending` | 🔑 `lms.content.approve` · 📦 `lms` | Content awaiting approval |
| POST | `/content/submissions/:id/grade` | 🔑 `lms.content.write` · 📦 `lms` | NAMESPACED UNDER `content/`, like every other route in this controller. |
| POST | `/guardians` | 🔑 `guardian.write` · 📦 `lms` | Link a parent to a child |
| DELETE | `/guardians/:parentId/:studentId` | 🔑 `guardian.write` · 📦 `lms` | Remove a guardian link. |
| PUT | `/live/:id` | 🔑 `lms.content.write` · 📦 `lms` | Update Live |
| GET | `/live/:id/attendance` | 🔑 `lms.content.write` · 📦 `lms` | Live Attendance |
| POST | `/live/:id/join` | 🔑 `lms.content.read` · 📦 `lms` | Reveal the join URL + record attendance (server gates the join window). |
| PUT | `/modules/:id` | 🔑 `lms.content.write` · 📦 `lms` | Rename Module |
| DELETE | `/modules/:id` | 🔑 `lms.content.write` · 📦 `lms` | Delete Module |
| GET | `/my/learning` | 🔑 `lms.content.read` · 📦 `lms` | A student's learning across every class they are enrolled in, unfinished first. |
| GET | `/promotions` | 🔑 `class.promote` · 📦 `lms` | Promotions |
| POST | `/promotions` | 🔑 `class.promote` · 📦 `lms` | Start an end-of-term promotion batch (PENDING) |
| GET | `/promotions/:id` | 🔑 `class.promote` · 📦 `lms` | Get Promotion |
| POST | `/promotions/:id/approve` | 🔑 `class.promote.approve` · 📦 `lms` | Approve a promotion (moves enrollments) |
| POST | `/promotions/:id/reject` | 🔑 `class.promote.approve` · 📦 `lms` | Reject a promotion (maker-checker) |
| GET | `/students` | 🔑 `class.read` · 📦 `lms` | Relationship-scoped student picker |
| POST | `/students/:studentId/documents/release` | 🔑 `student.exit.approve` · 📦 `lms` | Release (or withhold) a leaver's academic documents. |
| POST | `/students/:studentId/exit` | 🔑 `student.exit.request` · 📦 `lms` | RAISE a student exit. |
| GET | `/students/:studentId/exit/preview` | 🔑 `student.profile.read` · 📦 `lms` | What the approver should see first: classes, money owed, already-left. |
| POST | `/students/:studentId/readmit` | 🔑 `student.exit.approve` · 📦 `lms` | RE-ADMIT. |
| GET | `/students/count` | 🔑 `class.read` · 📦 `lms` | How many students the caller can see. |
| GET | `/students/exited` | 🔑 `student.profile.read` · 📦 `lms` | The leavers register. |
| PUT | `/students/exited/retention` | 🔑 `student.exit.approve` · 📦 `lms` · ⬆️ step-up | How long this school keeps a leaver's record before prompting a review. |
| GET | `/subjects` | 🔑 `class.read` · 📦 `lms` | List subjects |
| POST | `/subjects` | 🔑 `subject.manage` · 📦 `lms` | Create a subject (409 on a case-insensitive duplicate name) |
| PUT | `/subjects/:subjectId` | 🔑 `subject.manage` · 📦 `lms` | Rename / re-code a subject (offerings follow the id) |
| DELETE | `/subjects/:subjectId` | 🔑 `subject.manage` · 📦 `lms` | Delete an UNUSED subject (409 while any class offers it) |
| GET | `/subjects/catalogue` | 🔑 `class.read` · 📦 `lms` | The catalogue this school should be offered, with what it already has marked. |
| POST | `/subjects/from-catalogue` | 🔑 `class.write` · 📦 `lms` | Copy picked catalogue entries into this school's own subjects. |
| GET | `/syllabus` | 🔑 `class.read` · 📦 `lms` | The plan for one offering in one term. |
| PUT | `/syllabus` | 🔑 `class.read` · 📦 `lms` | Create or replace a term plan. |
| DELETE | `/syllabus/:id` | 🔑 `class.read` · 📦 `lms` | Remove a plan and its weeks. |
| PUT | `/syllabus/items/:id/status` | 🔑 `class.read` · 📦 `lms` | Mark a week taught, or put it back to planned. |
| GET | `/syllabus/term/:termId` | 🔑 `class.read` · 📦 `lms` | Every plan the caller may see for a term — the review view. |
| GET | `/users` | 🔑 `class.write` · 📦 `lms` | Staff-scoped user picker |
| GET | `/xapi/statements` | 🔑 `lms.content.read` · 📦 `lms` | List Statements |
| POST | `/xapi/statements` | 🔑 `lms.content.read` · 📦 `lms` | Record Statement |

---

## Legal acceptance

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/legal/acceptance` | 🔑 `billing.manage` | Record the caller's acceptance of the CURRENT version for their school. |
| GET | `/legal/acceptance/status` | 🔑 `billing.read` | Has THIS school accepted the current legal-pack version? |

---

## Library

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/library/books` | 🔑 `library.read` · 📦 `library` | Catalogue search / add |
| POST | `/library/books` | 🔑 `library.manage` · 📦 `library` | Catalogue search / add |
| PUT | `/library/books/:id` | 🔑 `library.manage` · 📦 `library` | Edit / rename a book |
| DELETE | `/library/books/:id` | 🔑 `library.manage` · 📦 `library` | Delete a book with NO lending history (409 otherwise) |
| GET | `/library/books/export.csv` | 🔑 `library.manage` · 📦 `library` | Catalogue CSV |
| GET | `/library/borrowers` | 🔑 `library.manage` · 📦 `library` | Who this librarian may issue to. `library.manage`, so a pupil holding `library.borrow` cannot enumerate the school through the lending desk. |
| GET | `/library/loans` | 🔑 `library.read` · 📦 `library` | Loans |
| GET | `/library/loans/:id/fine/receipt` | 🔑 `library.borrow` · 📦 `library` | Re-print a receipt for a fine already paid. `payFine` was the only source of it and refuses a second call, so closing the dialog lost the receipt permanently — for money the school had taken. |
| POST | `/library/loans/:id/pay-fine` | 🔑 `library.manage` · 📦 `library` | Body is optional: an existing caller that sends nothing still records CASH, which is what every row said before the method could be given at all. |
| POST | `/library/loans/:id/renew` | 🔑 `library.borrow` · 📦 `library` | Renew |
| POST | `/library/loans/:id/return` | 🔑 `library.manage` · 📦 `library` | Library staff only: a return records that the book is physically back. |
| POST | `/library/loans/issue` | 🔑 `library.borrow` · 📦 `library` | Issue a loan (copy claim is atomic — no negative availability under concurrency) |
| GET | `/library/report` | 🔑 `library.manage` · 📦 `library` | Library report |

---

## Messaging & the school calendar

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/events` | 🔑 `event.read` · 📦 `calendar` | `calendar` | School events |
| POST | `/events` | 🔑 `event.write` · 📦 `calendar` | `calendar` | School events |
| DELETE | `/events/:id` | 🔑 `event.write` · 📦 `calendar` | `calendar` | Delete an event |
| GET | `/messages/contacts` | 🔑 `message.send` · 📦 `messaging` | Contacts |
| GET | `/messages/search` | 🔑 `message.read` · 📦 `messaging` | Full-text search across the caller's own messages (GIN-indexed). |
| GET | `/messages/threads` | 🔑 `message.read` · 📦 `messaging` | Keyset-paginated: pass the previous response's `nextCursor` as `?cursor=`. |
| POST | `/messages/threads` | 🔑 `message.send` · 📦 `messaging` | Create — threads |
| GET | `/messages/threads/:id` | 🔑 `message.read` · 📦 `messaging` | Thread |
| POST | `/messages/threads/:id/reply` | 🔑 `message.send` · 📦 `messaging` | `messaging` | Reply |

---

## Notifications & preferences

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/notifications` | 🔑 `notification.read` | — | In-app inbox |
| POST | `/notifications` | 🔑 `notification.send` | Staff send to a user (relationship-scoped in the service). |
| POST | `/notifications/:id/read` | 🔑 `notification.read` | Mark one of the caller's own notifications read. |
| POST | `/notifications/credits/delivery-status` | 🌐 public | Twilio delivery-status callback. |
| GET | `/notifications/credits/ledger` | 🔑 `billing.read` | The school's OWN credit ledger — where its credits went. billing.read, the same permission that shows the balance beside it. |
| POST | `/notifications/credits/reconcile/run` | 🔑 `fee.reconcile.run` | Run the credit reconciliation now. |
| POST | `/notifications/credits/verify` | 🔑 `billing.read` | Settle a credit bundle the school has just returned from paying for. billing.read: the person coming back from the gateway is whoever started the checkout, and refusing to credit a bundle already paid for because of a… |
| GET | `/notifications/deliveries/problems` | 🔑 `notification.send` | What did NOT reach a family, and why. |
| POST | `/notifications/deliveries/recovery/run` | 🔑 `notification.send` · 🔑 `platform.operate` | Run the stranded-delivery sweep now (it also runs hourly). |
| GET | `/notifications/me/language` | 🔑 `notification.read` | The language the caller is written to in. |
| PUT | `/notifications/me/language` | 🔑 `notification.read` | Set or clear it. |
| GET · PUT | `/notifications/me/phone` | 🔑 `notification.read` | — | Own SMS/WhatsApp delivery number |
| GET · PUT | `/notifications/me/preferences` | 🔑 `notification.read` | — | Own external-channel prefs (email/SMS/WhatsApp toggles + per-type mutes). In-app inbox always delivered; essential types ignore mutes |
| POST | `/notifications/read-all` | 🔑 `notification.read` | Mark ALL of the caller's own notifications read — one statement, not one request per row. |

---

## Parent & family

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/admin/parents` | 🔑 `parent.import` · 📦 `sis` | Onboard ONE parent (or reuse an existing email) + link to students. |
| GET | `/admin/parents/import` | 🔑 `parent.import` · 📦 `sis` | List — import |
| POST | `/admin/parents/import` | 🔑 `parent.import` · 📦 `sis` | Stage a PENDING batch (creates nothing yet). |
| GET | `/admin/parents/import/:id` | 🔑 `parent.import` · 📦 `sis` | Get Batch |
| POST | `/admin/parents/import/:id/approve` | 🔑 `parent.import` · 📦 `sis` | Approve (SoD: different person) — creates accounts + links; credentials once. |
| POST | `/admin/parents/import/:id/reject` | 🔑 `parent.import` · 📦 `sis` | Reject |
| GET | `/admin/parents/import/template` | 🔑 `parent.import` · 📦 `sis` | Blank CSV template (header + one example row). |
| GET | `/family/overview` | 🔑 `family.read` · 📦 `sis` | Overview |

---

## Parent-teacher meetings

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/meetings/audiences` | 🔑 `meeting.host` | The audiences this host may address. |
| POST | `/meetings/bookings` | 🔑 `meeting.book` | Book |
| DELETE | `/meetings/bookings/:id` | (auth) | — | Cancel (booking parent, host teacher or staff-wide); other party notified |
| GET | `/meetings/bookings/mine` | 🔑 `meeting.book` | My Bookings |
| GET | `/meetings/requests` | 🔑 `meeting.request.read` | The requests this caller may see: a parent's own, a teacher's inbox, or every one for leadership. `?filter=open` is the queue, oldest first; `?filter=decided` the history. `pendingTotal` on the response is counted in… |
| POST | `/meetings/requests` | 🔑 `meeting.request` | A parent asks a teacher for a meeting about their own child. |
| DELETE | `/meetings/requests/:id` | 🔑 `meeting.request` | The parent withdraws their own request. |
| POST | `/meetings/requests/:id/decide` | 🔑 `meeting.host` | The teacher answers — accepting opens the meeting itself. |
| POST | `/meetings/requests/:id/review` | 🔑 `meeting.host` | Leadership passes a request to the teacher, or refuses it. |
| POST | `/meetings/slots` | 🔑 `meeting.host` | Create Slot |
| DELETE | `/meetings/slots/:id` | 🔑 `meeting.host` | — | Withdraw an unbooked slot (409 if booked) |
| GET | `/meetings/slots/mine` | 🔑 `meeting.host` | My Slots |
| GET | `/meetings/slots/open` | 🔑 `meeting.book` | — | Bookable slots (future, not full) |

---

## Payment rails (card, mobile money, webhooks)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/payments/mobile-money/callback/:provider` | 🌐 public | The rail's notification. |
| PUT | `/payments/mobile-money/callback/:provider` | 🌐 public | @see callback — MTN MoMo delivers the same payload as a PUT. |
| POST | `/payments/mobile-money/charge` | 🔑 `fee.read` | Send the payment prompt to a payer's handset. |
| GET | `/payments/mobile-money/options` | 🔑 `fee.read` | Which rails this school's payers can use, and which are enabled. |
| POST | `/payments/mobile-money/recovery/run` | 🔑 `fee.reconcile.run` | Run the recovery sweep now. |
| GET | `/payments/mobile-money/status` | 🔑 `fee.read` | The payer's screen polls this — the handset approval happens out of band. |

---

## Polls

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/polls` | 🔑 `poll.vote` · 📦 `poll` | `poll` | List / create polls |
| POST | `/polls` | 🔑 `poll.manage` · 📦 `poll` | `poll` | List / create polls |
| PUT | `/polls/:id` | 🔑 `poll.manage` · 📦 `poll` | Correct the question, audience or deadline. |
| DELETE | `/polls/:id` | 🔑 `poll.manage` · 📦 `poll` | Remove — polls |
| POST | `/polls/:id/close` | 🔑 `poll.manage` · 📦 `poll` | Close |
| PUT | `/polls/:id/options` | 🔑 `poll.manage` · 📦 `poll` | Replace the option list. |
| POST | `/polls/:id/vote` | 🔑 `poll.vote` · 📦 `poll` | Vote |

---

## Privacy, NDPR/GDPR & retention

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/privacy/archives` | 🔑 `privacy.archive.manage` | The archives this school holds. |
| POST | `/privacy/archives` | 🔑 `privacy.archive.manage` · ⬆️ step-up | Produce this year's archive. |
| POST | `/privacy/archives/:id/download` | 🔑 `privacy.archive.manage` · ⬆️ step-up | A time-limited link to the archive body, plus the checksum recorded when it was made — so whoever receives it can prove the bytes were not altered in the years between. |
| POST | `/privacy/archives/run-term-sweep` | 🔑 `privacy.archive.manage` · 🔑 `platform.operate` | Run the term sweep now — for an operator verifying it, or catching up after an outage. |
| POST | `/privacy/compliance/breach-deadlines/run` | 🔑 `privacy.compliance.manage` · 🔑 `platform.operate` | Run the Art. 33 deadline sweep now (it also runs hourly). |
| GET | `/privacy/compliance/breaches` | 🔑 `privacy.compliance.manage` | The breach register, overdue first. |
| POST | `/privacy/compliance/breaches` | 🔑 `privacy.compliance.manage` | Record a breach. |
| PUT | `/privacy/compliance/breaches/:id` | 🔑 `privacy.compliance.manage` | Record what was done about it. `discoveredAt` is deliberately not updatable — it is when the clock started. |
| GET | `/privacy/compliance/posture` | 🔑 `privacy.compliance.manage` | One screen for a DPO: regime, DPO contact, breach clock, retention, consent coverage — and what is MISSING as loudly as what is present. |
| GET · POST | `/privacy/erasure` | (auth) | Request / list right-to-erasure |
| POST | `/privacy/erasure/:id/review` | 🔑 `privacy.erasure.review` | Controller review of an erasure request |
| GET | `/privacy/export/:studentId` | (auth) | NDPR data-subject export bundle |

---

## Report cards

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/public/report-card/verify/:slug/:code` | 🌐 public | The code is 60 bits, so the limit is not what makes guessing hopeless — it bounds noise and keeps one scanner from becoming a load source. |
| POST | `/reportcards/:studentId/generate` | 🔑 `grade.read` · 📦 `gradebook` | Generate a report-card PDF (grades + attendance, **school logo embedded**); `?termId=` folds in that term's remarks |
| GET | `/reportcards/:studentId/remarks` | 🔑 `grade.read` · 📦 `gradebook` | Read a student's remarks for a term (report-card scope). |
| PUT | `/reportcards/:studentId/remarks/class-teacher` | 🔑 `grade.write` · 📦 `gradebook` | Class teacher (or staff) writes the class-teacher remark |
| PUT | `/reportcards/:studentId/remarks/head` | 🔑 `grade.read` · 📦 `gradebook` | Principal / school_admin writes the head remark |
| GET | `/reportcards/:studentId/traits` | 🔑 `grade.read` · 📦 `gradebook` | A pupil's behavioural / psychomotor ratings for a term. |
| PUT | `/reportcards/:studentId/traits` | 🔑 `grade.write` · 📦 `gradebook` | The class teacher (or staff-wide) records the whole set in one act. |
| GET | `/reportcards/classes/:classId/traits` | 🔑 `grade.write` · 📦 `gradebook` | Every pupil in a class with their ratings — what the entry grid reads. |

---

## Scholarships (platform-sponsored)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/scholarships/applications` | 🔑 `scholarship.admin` · 📦 `cbt` | Cross-tenant review queue (non-DRAFT applications across all schools). |
| POST | `/scholarships/applications` | 🔑 `scholarship.apply` · 📦 `cbt` | Apply |
| PUT | `/scholarships/applications/:id` | 🔑 `scholarship.apply` · 📦 `cbt` | Update Answers |
| POST | `/scholarships/applications/:id/award` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | AWARD — disburses a fees credit; step-up (money moves). |
| POST | `/scholarships/applications/:id/consent` | 🔑 `scholarship.apply` · 📦 `cbt` | Guardian consent — required before submission (Golden Rule #5). |
| POST | `/scholarships/applications/:id/decision` | 🔑 `scholarship.apply` · 🔑 `workflow.review.principal` · 📦 `cbt` | Chain decision (student-initiated requests): the CLASS SUPERVISOR, then the GUARDIAN (whose approval doubles as consent), then the PRINCIPAL each approve or reject. |
| POST | `/scholarships/applications/:id/review` | 🔑 `scholarship.admin` · 📦 `cbt` | Non-award decisions: REVIEW / SHORTLIST / REJECT. |
| POST | `/scholarships/applications/:id/revoke` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Take an award back — step-up, for the same reason the award needs it: money moves, in the other direction. |
| POST | `/scholarships/applications/:id/submit` | 🔑 `scholarship.apply` · 📦 `cbt` | Submit |
| POST | `/scholarships/applications/decide-bulk` | 🔑 `scholarship.admin` · 📦 `cbt` | Move a whole selection through the funnel at once. |
| GET | `/scholarships/banks` | 🔑 `scholarship.admin` · 📦 `cbt` | Banks |
| POST | `/scholarships/banks` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Create Bank |
| GET | `/scholarships/banks/:id` | 🔑 `scholarship.admin` · 📦 `cbt` | One bank WITH its questions — bounded by the bank, so never paged. |
| PUT | `/scholarships/banks/:id` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Correct a bank's name or subject. |
| DELETE | `/scholarships/banks/:id` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Papers already built are UNAFFECTED — they hold copies, not references. |
| POST | `/scholarships/banks/:id/reopen` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Back to DRAFT, so a finished bank can be corrected and finished again. |
| POST | `/scholarships/banks/:id/save` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Save Bank |
| GET | `/scholarships/exams/:programId/papers` | 🔑 `scholarship.apply` · 📦 `cbt` | The papers this candidate has, and where each stands. |
| POST | `/scholarships/exams/:programId/start` | 🔑 `scholarship.apply` · 📦 `cbt` | Start Exam |
| GET | `/scholarships/portal` | 🔑 `scholarship.apply` · 🔑 `workflow.review.principal` · 📦 `cbt` | Open programs + students I can apply for + my applications + anything waiting on MY decision. |
| GET | `/scholarships/programs` | 🔑 `scholarship.admin` · 📦 `cbt` | List Programs |
| POST | `/scholarships/programs` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Create Program |
| PUT | `/scholarships/programs/:id` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Update Program |
| POST | `/scholarships/programs/:id/announce-exam` | 🔑 `scholarship.admin` · 📦 `cbt` | Announce the qualification exam to every QUALIFIED candidate AND materialize the real sitting surface (ONLINE_CBT per-school exams / GAMES arena). |
| GET | `/scholarships/programs/:id/answer-key.pdf` | 🔑 `scholarship.admin` · 📦 `cbt` | The same paper WITH the answers. |
| POST | `/scholarships/programs/:id/collect-results` | 🔑 `scholarship.admin` · 📦 `cbt` | Harvest CBT/arena results back onto the candidates' applications as an exam-score SIGNAL to inform the award (Golden Rule #8). |
| GET | `/scholarships/programs/:id/paper.pdf` | 🔑 `scholarship.admin` · 📦 `cbt` | The printed paper for ONE subject, for a physical sitting. |
| POST | `/scholarships/programs/:id/publish-results` | 🔑 `scholarship.admin` · 📦 `cbt` | Publish this programme's results to every school. `scholarship.admin`. |
| GET | `/scholarships/programs/:id/questions` | 🔑 `scholarship.admin` · 📦 `cbt` | The exam paper as written, WITH answers — `scholarship.admin` only, so the person who wrote it can read it back and correct it. |
| POST | `/scholarships/programs/:id/questions/copy` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Copy library questions onto a programme's paper. |
| GET | `/scholarships/programs/:id/school-spread` | 🔑 `scholarship.admin` · 📦 `cbt` | How the programme is spread across schools — applied / qualified / awarded and the seats each has left under the per-school cap. |
| POST | `/scholarships/programs/:id/scores` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Record a PHYSICAL exam's marks by hand — the only mode with no sitting to harvest, and the one that could be announced and never scored. |
| POST | `/scholarships/programs/:id/unpublish-results` | 🔑 `scholarship.admin` · 📦 `cbt` | Unpublish |
| GET | `/scholarships/questions` | 🔑 `scholarship.admin` · 📦 `cbt` | Browse the library. |
| POST | `/scholarships/questions` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Create Library Question |
| PUT | `/scholarships/questions/:id` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Update Library Question |
| DELETE | `/scholarships/questions/:id` | 🔑 `scholarship.admin` · 📦 `cbt` · ⬆️ step-up | Papers already built are UNAFFECTED — they hold a copy, not a reference. |
| GET | `/scholarships/results` | 🔑 `scholarship.apply` · 🔑 `workflow.review.principal` · 📦 `cbt` | The published results, readable by EVERY SCHOOL on the platform. |
| GET | `/scholarships/school-applications` | 🔑 `scholarship.read` · 📦 `cbt` | School leadership's oversight of their OWN school's applications. |
| GET | `/scholarships/sittings/:id` | 🔑 `scholarship.apply` · 📦 `cbt` | Exam Sitting |
| POST | `/scholarships/sittings/:id/answer` | 🔑 `scholarship.apply` · 📦 `cbt` | Answer Exam |
| POST | `/scholarships/sittings/:id/answer-theory` | 🔑 `scholarship.apply` · 📦 `cbt` | Answer Exam Theory |
| POST | `/scholarships/sittings/:id/integrity` | 🔑 `scholarship.apply` · 📦 `cbt` | Exam Integrity |
| POST | `/scholarships/sittings/:id/submit` | 🔑 `scholarship.apply` · 📦 `cbt` | Submit Exam |
| GET | `/scholarships/subjects` | 🔑 `scholarship.admin` · 📦 `cbt` | The subjects a bank can be created for — the catalogue's secondary concepts across every curriculum, so the picker is never one school's. |

---

## School administration

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/admin/export/staff.csv` | 🔑 `rbac.manage` | Staff Csv |
| GET | `/admin/export/students.csv` | 🔑 `rbac.manage` | Students Csv |
| POST | `/admin/import/students` | 🔑 `class.write` | Legacy bulk import |
| GET | `/admin/roles` | 🔑 `rbac.manage` | Roles |
| GET | `/admin/security/mfa-policy` | 🔑 `rbac.manage` | Per-school "require MFA for all staff" policy (staff = any role but student/parent; super_admin exempt) |
| PUT | `/admin/security/mfa-policy` | 🔑 `rbac.manage` · ⬆️ step-up | Per-school "require MFA for all staff" policy (staff = any role but student/parent; super_admin exempt) |
| POST | `/admin/sis/nudge/run` | 🔑 `rbac.manage` | Nudge this school's pupils whose SIS profile is still outstanding, on demand. |
| GET | `/admin/students/import` | 🔑 `student.import` | List Imports |
| POST | `/admin/students/import` | 🔑 `student.import` | Upload a PENDING import batch |
| GET | `/admin/students/import/:id` | 🔑 `student.import` | Get Import |
| POST | `/admin/students/import/:id/approve` | 🔑 `student.import` | Approve a PENDING batch — a DIFFERENT person than the uploader (SoD). |
| POST | `/admin/students/import/:id/reject` | 🔑 `student.import` | Reject Import |
| GET | `/admin/students/import/template` | 🔑 `student.import` | CSV import template |
| GET | `/admin/users` | 🔑 `rbac.manage` | List this school's users (directory / staff picker). |
| POST | `/admin/users` | 🔑 `rbac.manage` | Create a profile (any non-super_admin role) within the caller's own school. |
| POST | `/admin/users/:userId/roles` | 🔑 `rbac.manage` · ⬆️ step-up | Assign |
| DELETE | `/admin/users/:userId/roles/:roleName` | 🔑 `rbac.manage` · ⬆️ step-up | Remove a role. 409 on removing your OWN school_admin/principal role or the school's LAST managing role |

---

## School directory

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/directory/people` | 🔑 `directory.people.read` | Picker options: id + name + roles, never an email. |
| GET | `/directory/search` | 🔑 `directory.search` | Cross-role people search (CROSS-SCHOOL registry) |

---

## School-group console (multi-campus)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/group/overview` | 📦 `group` | The caller's cross-campus dashboard (directors only; audited). `?groupId=` picks among the groups they direct — a proprietor with two chains used to see only the first, silently. `?period=` widens the window beyond th… |
| GET | `/group/overview.csv` | 📦 `group` | The overview as CSV, for a board pack. |
| GET | `/group/schools/:schoolId` | 📦 `group` | One campus in depth — trends and where the money is stuck. |

---

## Student discipline

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/discipline/complaints` | 🔑 `discipline.file` · 📦 `discipline` | `discipline` | Complaints |
| GET | `/discipline/complaints/:id` | 🔑 `discipline.file` · 📦 `discipline` | Get — complaints |
| POST | `/discipline/complaints/:id/assign` | 🔑 `discipline.manage` · 📦 `discipline` | `discipline` | Assign a handler |
| DELETE | `/discipline/complaints/:id/assign/:assigneeId` | 🔑 `discipline.manage` · 📦 `discipline` | Take the case back off somebody. |
| POST | `/discipline/complaints/:id/entries` | 🔑 `discipline.manage` · 📦 `discipline` | Entry |
| GET | `/discipline/complaints/:id/evidence/:evidenceId` | 🔑 `discipline.file` · 📦 `discipline` | Download |
| POST | `/discipline/complaints/:id/evidence/confirm` | 🔑 `discipline.manage` · 📦 `discipline` | Confirm |
| POST | `/discipline/complaints/:id/evidence/presign` | 🔑 `discipline.manage` · 📦 `discipline` | Presign |
| POST | `/discipline/complaints/:id/resolve` | 🔑 `discipline.manage` · 📦 `discipline` | Resolve |
| GET | `/discipline/file-targets` | 🔑 `discipline.file` · 📦 `discipline` | Relationship-scoped people the caller may file against, for the picker. |

---

## Student information (profile, contacts, medical)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/students/:studentId/contacts` | 🔑 `student.contact.read` · 📦 `sis` | Emergency contacts |
| POST | `/students/:studentId/contacts` | 🔑 `student.contact.write` · 📦 `sis` | Emergency contacts |
| PATCH · DELETE | `/students/:studentId/contacts/:contactId` | 🔑 `student.contact.write` · 📦 `sis` | Edit / remove a contact |
| GET | `/students/:studentId/guardians` | 🔑 `student.profile.read` · 📦 `sis` | The parent accounts linked to this pupil, and whether notices can reach them. |
| GET | `/students/:studentId/medical` | 🔑 `student.medical.read` · 📦 `sis` | Encrypted medical record (read, audited) |
| PUT | `/students/:studentId/medical` | 🔑 `student.medical.write` · 📦 `sis` · ⬆️ step-up | Update medical record (step-up) |
| GET | `/students/:studentId/profile` | 🔑 `student.profile.read` · 📦 `sis` | Student profile (name, DOB, gender, state…) |
| PUT | `/students/:studentId/profile` | 🔑 `student.profile.write` · 📦 `sis` | Student profile (name, DOB, gender, state…) |
| POST | `/students/:studentId/profile/approve` | 🔑 `rbac.manage` · 📦 `sis` | STAGE 2 — the SCHOOL ADMIN approves (rbac.manage: principal / school_admin). |
| GET | `/students/:studentId/profile/completion` | 🔑 `student.profile.read` · 📦 `sis` | What the pupil still has to fill in (drives the first-sign-in prompt). |
| POST | `/students/:studentId/profile/submit` | 🔑 `student.profile.write` · 📦 `sis` | The pupil (or their parent) submits the finished profile for review. |
| POST | `/students/:studentId/profile/supervisor-review` | 🔑 `student.profile.read` · 📦 `sis` | STAGE 1 — the CLASS SUPERVISOR checks it. |
| GET | `/students/profile-reviews` | 🔑 `student.profile.read` · 📦 `sis` | Profiles waiting on THIS reviewer, with the stage decided server-side. |

---

## Subscription billing & add-ons

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/billing` | 🔑 `billing.read` | Current plan + per-tier quotes (operator-effective pricing) + payment history |
| GET | `/billing/addons` | 🔑 `billing.read` | The modules this school can buy on its own, with prices — the add-on shop. |
| POST | `/billing/addons/:module/cancel` | 🔑 `billing.manage` | Stop renewing an add-on. |
| POST | `/billing/addons/:module/init` | 🔑 `billing.manage` · ⬆️ step-up | Buy ONE module. |
| PUT | `/billing/auto-renew` | 🔑 `billing.manage` · ⬆️ step-up | Opt in/out of saved-card auto-renew. |
| POST | `/billing/checkout/init` | 🔑 `billing.manage` · ⬆️ step-up | Start Paystack checkout for a chosen tier |
| GET | `/billing/credits` | 🔑 `billing.read` | Message-credit balance + purchasable bundles (SMS/WhatsApp metering). |
| POST | `/billing/credits/checkout` | 🔑 `billing.manage` · ⬆️ step-up | Buy a message-credit bundle (hosted Paystack checkout). |
| POST | `/billing/dunning/run` | 🔑 `billing.dunning.run` | Manual delinquency sweep (flips elapsed subs to PAST_DUE) |
| GET | `/billing/payments/:id/receipt.pdf` | 🔑 `billing.read` | Receipt PDF for a PAID subscription payment. 404-not-403; audited. billing.read, not billing.manage — a bursar who files the receipt is not necessarily the person allowed to change the plan. |
| POST | `/billing/payments/verify` | 🔑 `billing.read` | Verify a payment the school has just returned from paying. billing.read, not billing.manage: the person coming back from the gateway is whoever started the checkout, and refusing to settle a payment already taken beca… |
| GET | `/billing/referral` | 🔑 `billing.read` | The school's referral panel: shareable code + conversions earned. |
| POST | `/billing/referral/code` | 🔑 `billing.manage` | Generate the school's referral code (idempotent; audited). |
| GET | `/billing/status` | 🔑 `billing.read` | Light subscription posture (drives the AppShell renewal/past-due banner) |
| POST | `/billing/stripe/webhook` | 🌐 public | Stripe webhook (USD subscription payments). |
| POST | `/billing/true-up/init` | 🔑 `billing.manage` · ⬆️ step-up | Start a checkout for the seat true-up quoted on the overview. |

---

## Tasks

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/tasks` | 🔑 `task.participate` · 📦 `task` | `task` | List / create tasks |
| POST | `/tasks` | 🔑 `task.assign` · 📦 `task` | `task` | List / create tasks |
| GET | `/tasks/:id/assignments/:assignmentId/attachment` | 🔑 `task.participate` · 📦 `task` | `task` | Download attachment |
| POST | `/tasks/:id/attachment/confirm` | 🔑 `task.participate` · 📦 `task` | Confirm |
| POST | `/tasks/:id/attachment/presign` | 🔑 `task.participate` · 📦 `task` | Presign |
| POST | `/tasks/:id/comments` | 🔑 `task.participate` · 📦 `task` | Comment |
| PUT | `/tasks/:id/me` | 🔑 `task.participate` · 📦 `task` | An assignee updates their own assignment status/note. |
| PUT | `/tasks/:id/status` | 🔑 `task.assign` · 📦 `task` | Set Status |

---

## Timetable, cover & availability

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/timetable/availability` | 🔑 `timetable.read` · 📦 `timetable` | List Availability |
| PUT | `/timetable/availability/:teacherId` | 🔑 `timetable.write` · 📦 `timetable` | Replace a teacher's full set of unavailable (day, period) slots. |
| GET | `/timetable/classes/:classId` | 🔑 `timetable.read` · 📦 `timetable` | A class's weekly timetable |
| GET | `/timetable/cover` | 🔑 `timetable.read` · 📦 `timetable` | Lessons whose regular teacher is on approved leave in [from,to], with any assigned cover. |
| POST | `/timetable/cover` | 🔑 `timetable.write` · 📦 `timetable` | Assign a reliever (self-cover 400, double-booking 409; reliever notified) |
| DELETE | `/timetable/cover/:id` | 🔑 `timetable.write` · 📦 `timetable` | Remove a cover assignment |
| GET | `/timetable/cover/mine` | 🔑 `timetable.read` · 📦 `timetable` | The caller's own cover duties in [from,to]. |
| GET | `/timetable/entries` | 🔑 `timetable.read` · 📦 `timetable` | Lesson grid (double-booking → 409) |
| POST | `/timetable/entries` | 🔑 `timetable.write` · 📦 `timetable` | Lesson grid (double-booking → 409) |
| PATCH · DELETE | `/timetable/entries/:id` | 🔑 `timetable.write` · 📦 `timetable` | Edit / delete a lesson |
| GET | `/timetable/export.csv` | 🔑 `timetable.read` · 📦 `timetable` | The grid as CSV — one row per lesson. |
| POST | `/timetable/generate` | 🔑 `timetable.write` · 📦 `timetable` | Auto-generate a clash-free timetable |
| GET | `/timetable/load` | 🔑 `timetable.read` · 📦 `timetable` | Standing teaching load per teacher — assigned vs available periods. |
| GET | `/timetable/periods` | 🔑 `timetable.read` · 📦 `timetable` | Periods |
| POST | `/timetable/periods` | 🔑 `timetable.write` · 📦 `timetable` | Periods |
| PATCH | `/timetable/periods/:id` | 🔑 `timetable.write` · 📦 `timetable` | Edit a period |
| DELETE | `/timetable/periods/:id` | 🔑 `timetable.write` · 📦 `timetable` | Remove a period. 409 (naming the count) while lessons are scheduled in it. |
| POST | `/timetable/periods/generate` | 🔑 `timetable.write` · 📦 `timetable` | Generate the whole day from teaching-period count + break positions. |
| GET | `/timetable/print.pdf` | 🔑 `timetable.read` · 📦 `timetable` | Print |
| GET | `/timetable/rooms` | 🔑 `timetable.read` · 📦 `timetable` | Rooms |
| POST | `/timetable/rooms` | 🔑 `timetable.write` · 📦 `timetable` | Rooms |
| PATCH | `/timetable/rooms/:id` | 🔑 `timetable.write` · 📦 `timetable` | Edit a room |
| DELETE | `/timetable/rooms/:id` | 🔑 `timetable.write` · 📦 `timetable` | Remove a room. 409 while lessons are scheduled in it or an offering still names it as preferred. |
| GET | `/timetable/unstaffed` | 🔑 `timetable.read` · 📦 `timetable` | Lessons whose regular teacher has left the school. |
| GET | `/timetable/view` | 🔑 `timetable.read` · 📦 `timetable` | The grid along whichever axis you ask for: class, TEACHER or ROOM. |

---

## Transport & fleet

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/transport/assignments` | 🔑 `transport.read` · 📦 `transport` | Passenger assignments |
| POST | `/transport/assignments` | 🔑 `transport.manage` · 📦 `transport` | Passenger assignments |
| POST | `/transport/assignments/:id/cancel` | 🔑 `transport.manage` · 📦 `transport` | Cancel |
| POST | `/transport/assignments/:id/change-route` | 🔑 `transport.manage` · 📦 `transport` | Change Route |
| GET | `/transport/boardings` | 🔑 `transport.read` · 📦 `transport` | Boardings |
| POST | `/transport/boardings` | 🔑 `transport.read` · 📦 `transport` | Record Boarding |
| POST | `/transport/fees/schedule` | 🔑 `transport.manage` · 📦 `transport` | Bill transport fees — admins post directly; the head driver's run becomes a FEE_SCHEDULE approval request (maker-checker) |
| GET | `/transport/locations` | 🔑 `transport.read` · 📦 `transport` | Locations |
| POST | `/transport/locations` | 🔑 `transport.read` · 📦 `transport` | Ingest Location |
| GET | `/transport/maintenance` | 🔑 `transport.read` · 📦 `transport` | Maintenance |
| POST | `/transport/maintenance` | 🔑 `transport.manage` · 📦 `transport` | Add Maintenance |
| GET | `/transport/routes` | 🔑 `transport.read` · 📦 `transport` | Routes |
| POST | `/transport/routes` | 🔑 `transport.manage` · 📦 `transport` | Routes |
| PUT | `/transport/routes/:id` | 🔑 `transport.manage` · 📦 `transport` | Rename a route (assignments/stops/fees follow the id) |
| POST | `/transport/routes/:id/retire` | 🔑 `transport.manage` · 📦 `transport` | Retire Route |
| POST | `/transport/routes/:id/stops` | 🔑 `transport.manage` · 📦 `transport` | Add Stop |
| POST | `/transport/routes/:id/stops/reorder` | 🔑 `transport.manage` · 📦 `transport` | Reorder a route's stops from an explicit id list (arrows/drag, not a number). |
| GET | `/transport/summary` | 🔑 `transport.read` · 📦 `transport` | Fleet analytics (driver-scoped or school-wide) |
| GET | `/transport/trips` | 🔑 `transport.read` · 📦 `transport` | Trips |
| POST | `/transport/trips` | 🔑 `transport.manage` · 📦 `transport` | Create Trip |
| PUT | `/transport/trips/:id` | 🔑 `transport.manage` · 📦 `transport` | Update Trip |
| GET | `/transport/vehicles` | 🔑 `transport.read` · 📦 `transport` | Vehicles (driver sees own; head_driver sees the fleet) |
| POST | `/transport/vehicles` | 🔑 `transport.manage` · 📦 `transport` | Vehicles (driver sees own; head_driver sees the fleet) |
| PUT | `/transport/vehicles/:id` | 🔑 `transport.manage` · 📦 `transport` | Edit / rename a vehicle |
| DELETE | `/transport/vehicles/:id` | 🔑 `transport.manage` · 📦 `transport` | Delete a vehicle no route uses (admin-only; 409 otherwise) |

---

## Realtime (WebSocket — not HTTP)

The `GameSocketGateway` runs `ws` on the same HTTP server under `/ws/*`:

- `/ws/duel` · `/ws/ring` · `/ws/race` · `/ws/arena` — in-memory game transport.
- `/ws/watch?mode={duel|ring|race|league|ultimate}&gameId=…` — durable, RLS-scoped, viewer-redacted spectator bridge; re-reads the same view the mode's HTTP GET returns.

Handshake auth: HS256 `?token=` minted by the web BFF (`GET /api/ws-ticket`). The school's status is re-checked at the handshake AND on every push, so a suspended tenant's open socket stops receiving state rather than running until it happens to reconnect.

