# API Reference — School Management System

Complete HTTP endpoint reference for the NestJS API (`apps/api`). **634 endpoints across 75 controllers.**

## Conventions

- **Base URL:** the API is stateless and mounted at the service root (e.g. `http://localhost:3001`). The Next.js web app reaches it through a same-origin BFF proxy (`/api/sms/*` for authed calls, `/api/public/*` for public ones) which injects the Bearer token server-side.
- **Auth:** every non-public request carries a Bearer JWT (HS256, `algorithms: ["HS256"]` pinned) minted by the Auth.js layer at login; it holds `userId`, `school_id`, `roles`, `permissions`. The API **verifies** it on every request and never issues sessions.
- **Tenant isolation (3 layers):** JWT `school_id` claim → NestJS `PermissionGuard` → Postgres Row-Level Security. Cross-tenant access returns **404, not 403** (never leak existence).
- **Every mutation is audit-logged** (actor, action, entity, `school_id`, timestamp).

### Gate legend

| Symbol | Meaning |
|---|---|
| 🌐 **public** | `@Public()` — no authentication |
| 🔑 **perm** | `@RequirePermission(...)` — a fine-grained permission is required |
| 📦 **module** | `@RequireModule(...)` — the school's subscription must include the module (else **404**) |
| ⬆️ **step-up** | `@RequireStepUp()` — a fresh 5-minute step-up re-auth token is required (`x-stepup` header) |

Permission strings below are the fine-grained values (e.g. `grade.write`) checked by the guard and backstopped by RLS.

---

## Foundation, auth & platform-public

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/auth/login` | 🌐 (rate-limited 10/min/IP) | Verify credentials + MFA + 3-strike lockout, return the signed session JWT + modules |
| GET | `/health` | 🌐 | Liveness/readiness probe |
| GET | `/metrics` | 🌐 (bearer/`x-metrics-token`) | Prometheus metrics scrape (process + HTTP + per-tenant counters) |
| GET | `/public/schools` | 🌐 | Public list of onboarded schools (parent directory; excludes the platform org) |
| POST | `/public/onboarding-requests` | 🌐 | A prospective school requests to join (homepage CTA) |
| GET | `/public/schools/:slug/branding` | 🌐 | A school's login-page logo + theme by slug (hidden when subscription lapsed) |
| GET | `/public/plan-pricing` | 🌐 | Effective per-tier pricing (operator overrides merged over defaults) — the landing page derives its prices from this |

---

## Security, MFA & privilege elevation

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/security/audit` | 🔑 `security.audit.read` | Scoped, filterable audit-log viewer |
| GET | `/security/recertification` | 🔑 `security.audit.read` | Access-recertification report |
| GET | `/security/anomalies` | 🔑 `security.audit.read` | Access-anomaly signals |
| GET | `/security/elevation` | 🔑 `security.audit.read` | List privilege-elevation grants |
| POST | `/security/elevation/request` | 🔑 `security.elevation.request` | Request just-in-time elevation (or break-glass) |
| POST | `/security/elevation/:id/approve` | 🔑 `security.elevation.approve` | Approve elevation (must be a different person) |
| POST | `/security/elevation/:id/revoke` | 🔑 `security.elevation.approve` | Revoke an active grant |
| GET | `/security/mfa/status` | 🔑 | Current user's MFA enrolment status |
| POST | `/security/mfa/enroll` | (auth) | Begin TOTP enrolment |
| POST | `/security/mfa/verify` | (auth) | Confirm TOTP enrolment |
| POST | `/security/mfa/disable` | ⬆️ | Disable MFA (step-up required) |
| POST | `/security/stepup` | (auth) | Mint a 5-minute step-up token for sensitive actions |

---

## Super-admin operator console (platform owner)

All gated by 🔑 `platform.operate`.

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/operator/tenants` | ⬆️ | Provision a new school + its founding admin tier |
| POST | `/operator/tenants/:schoolId/admins` | ⬆️ | Add an admin to an existing school |
| GET | `/operator/tenants` | | Cross-tenant school registry — server-side search/filter/pagination (`q`, `plan`, `billing`, `page`, `pageSize` → `TenantPageDto`) |
| GET | `/operator/tenant-names` | | Lightweight id+name list for pickers (single query) |
| GET | `/operator/pricing` | | Effective per-tier pricing + default/override flags |
| PUT | `/operator/pricing` | ⬆️ | Set per-tier per-seat prices (platform-wide; feeds quotes, checkout and the public page; audited) |
| GET | `/operator/analytics` | | Graphical platform business metrics (MRR, ARPA, growth, funnel, churn, module adoption, demographics) |
| GET | `/operator/admin-appointments` | | Cross-tenant junior-admin ADMIN_APPOINTMENT oversight (`?state=` filter; read-only — the school's second senior decides) |
| GET | `/operator/audit` | | Cross-tenant audit trail, actor-attributed (email + unique id + roles), cursor-paginated |
| GET | `/operator/audit/export.csv` | | Downloadable CSV audit report (formula-injection safe) |
| POST | `/operator/impersonate` | ⬆️ | Mint an audited, scoped impersonation token |
| GET | `/operator/tenants/:schoolId/subscription` | | A school's subscription (plan + modules) |
| PUT | `/operator/tenants/:schoolId/subscription` | | Set plan + per-module overrides / comp status |
| GET | `/operator/onboarding-requests` | | Review queue of public onboarding requests |
| POST | `/operator/onboarding-requests/:id/status` | | Approve / reject / mark-reviewing a request |
| GET | `/operator/tenants/:schoolId/students` | | Cross-tenant student view — by ROLE (not-yet-enrolled included), active class names attached; audited |
| GET | `/operator/tenants/:schoolId/users` | | Cross-tenant user view |
| PUT | `/operator/tenants/:schoolId/users/:userId/status` | ⬆️ | Enable/disable a user account |
| POST | `/operator/tenants/:schoolId/users/:userId/unlock` | | Clear a failed-login lockout |
| POST | `/operator/tenants/:schoolId/users/:userId/reset-password` | ⬆️ | Issue a temporary password |
| POST | `/operator/tenants/:schoolId/users/:userId/mfa/reset` | ⬆️ | Reset a user's MFA |
| PUT | `/operator/tenants/:schoolId/users/:userId/mfa-required` | | Mandate MFA for a user |
| PUT | `/operator/tenants/:schoolId/roles/:roleName/mfa-required` | | Mandate MFA for a role |

---

## Billing (self-serve subscription)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/billing` | 🔑 `billing.read` | Current plan + per-tier quotes (operator-effective pricing) + payment history |
| GET | `/billing/status` | 🔑 `billing.read` | Light subscription posture (drives the AppShell renewal/past-due banner) |
| POST | `/billing/checkout/init` | 🔑 `billing.read` ⬆️ | Start Paystack checkout for a chosen tier |
| POST | `/billing/dunning/run` | 🔑 `billing.dunning.run` | Manual delinquency sweep (flips elapsed subs to PAST_DUE) |

---

## LMS — classes, subjects, enrollment, promotion 📦 `lms`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/classes` | 🔑 `class.write` | Create a class |
| PUT | `/classes/:classId` | 🔑 `class.write` | Edit a class (level / next-class / supervisor) |
| DELETE | `/classes/:classId` | 🔑 `class.write` | Delete a class — only while EMPTY (e.g. a duplicate created in error) |
| POST | `/subjects` | 🔑 `subject.manage` | Create a subject (409 on a case-insensitive duplicate name) |
| GET | `/subjects` | 🔑 `class.read` | List subjects |
| PUT | `/subjects/:subjectId` | 🔑 `subject.manage` | Rename / re-code a subject (offerings follow the id) |
| DELETE | `/subjects/:subjectId` | 🔑 `subject.manage` | Delete an UNUSED subject (409 while any class offers it) |
| POST | `/classes/:classId/subjects` | 🔑 `class.read` | Assign a teacher to a class-subject |
| GET | `/classes/:classId/subjects` | 🔑 `class.read` | List a class's subject-teacher offerings |
| DELETE | `/classes/:classId/subjects/:subjectId` | 🔑 `subject.manage` | Remove a subject offering from a class |
| POST | `/classes/:classId/teachers` | 🔑 `enrollment.write` | Assign a teacher to a class |
| POST | `/classes/:classId/enrollments` | 🔑 `enrollment.write` | Enroll students |
| POST | `/guardians` | 🔑 `guardian.write` | Link a parent to a child |
| GET | `/classes/mine` | 🔑 `class.read` | The caller's relationship-scoped classes |
| GET | `/students` | 🔑 `class.read` | Relationship-scoped student picker |
| GET | `/users` | 🔑 `class.read` | Staff-scoped user picker |
| GET | `/classes/:classId` | 🔑 `class.write` | Class detail (admin) |
| GET | `/classes/:classId/info` | 🔑 `enrollment.read` | Class membership summary |
| GET | `/classes/:classId/eligibility` | 🔑 `class.read` | Who may be enrolled |
| GET | `/classes/:classId/roster.csv` | 🔑 `enrollment.read` | Roster CSV export |
| PUT | `/classes/:classId/enrollments/:studentId/status` | 🔑 `enrollment.write` | Transfer / withdraw / graduate an enrollment |
| GET | `/academic/sessions` | 🔑 `class.read` | Academic sessions |
| POST | `/academic/sessions` | 🔑 `class.read` | Create a session |
| POST | `/academic/sessions/:id/terms` | 🔑 `academic.manage` | Add a term |
| PUT | `/academic/sessions/:id/current` | 🔑 `academic.manage` | Set current session |
| PUT | `/academic/terms/:id/current` | 🔑 `academic.manage` | Set current term |
| POST | `/promotions` | 🔑 `class.promote` | Start an end-of-term promotion batch (PENDING) |
| GET | `/promotions` · `/promotions/:id` | 🔑 `class.promote` | List / inspect promotion batches |
| POST | `/promotions/:id/approve` | 🔑 `class.promote` | Approve a promotion (moves enrollments) |
| POST | `/promotions/:id/reject` | 🔑 `class.promote.approve` | Reject a promotion (maker-checker) |

### LMS content (approval-gated) 📦 `lms`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/classes/:classId/content` | 🔑 `content.write` | Create learning content |
| GET | `/classes/:classId/content` | 🔑 `content.read` | List class content |
| GET | `/content/approvals/pending` | 🔑 `content.read` | Content awaiting approval |
| GET | `/content/:id` | 🔑 `content.approve` | Content detail (reviewer) |
| PUT | `/content/:id` | 🔑 `content.read` | Edit content |
| POST | `/content/:id/upload` · `/upload/confirm` | 🔑 `content.write` | Attach a file (presigned) |
| GET | `/content/:id/download` | 🔑 `content.write` | Download attachment |
| POST | `/content/:id/submit` | 🔑 `content.read` | Submit content for approval |
| POST | `/content/:id/review` | 🔑 `content.write` | Approve/reject content |
| POST | `/content/:id/quiz/attempt` | 🔑 `quiz.attempt` | Attempt a quiz |
| GET | `/content/:id/quiz/me` | 🔑 `content.read` | Own quiz results |
| GET · POST | `/content/:id/forum` | 🔑 `content.read` | Course forum |

---

## Gradebook 📦 `gradebook`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/submissions/:submissionId/grade` | 🔑 `grade.write` | Record/publish a grade |
| GET | `/submissions/:submissionId/grade` | 🔑 `grade.read` | Read a grade |
| GET | `/grades/mine` | 🔑 `grade.read` | Student/parent own-grade view |

---

## Assessment Integrity 📦 `integrity`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/assessments` | 🔑 `assessment.read` | List / create assessments |
| PUT | `/assessments/:assessmentId` | 🔑 `assessment.write` | Edit an assessment |
| GET | `/assessments/:assessmentId/submissions` | 🔑 `integrity.report.read` | Submissions for review |
| GET | `/assessments/:assessmentId/take` | 🔑 `assessment.read` | Student take view |
| POST | `.../submissions/:id/signals` | 🔑 `integrity.signal.create` | Client-side integrity signals |
| POST | `.../submissions/:id/autosave` · `/start` · `/submit` | 🔑 `submission.write` | Draft autosave / start / submit |
| POST | `.../submissions/:id/file/presign` · `/file/confirm` | 🔑 `submission.write` | Submission file upload |
| GET | `.../submissions/:id/file` | 🔑 `submission.read` | Download a submission file |
| GET | `.../submissions/:id/integrity-report` | 🔑 `integrity.report.read` | Aggregated integrity report (human review) |
| POST | `/integrity/retention/run` | 🔑 `integrity.retention.run` | Purge minors' telemetry past the retention window |
| GET | `/integrity/retention/runs` | 🔑 `integrity.retention.run` | Retention-run history |

---

## SIS — student profile / contacts / medical 📦 `sis`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · PUT | `/students/:studentId/profile` | 🔑 `student.profile.read` | Student profile (name, DOB, gender, state…) |
| GET · POST | `/students/:studentId/contacts` | 🔑 `student.contact.read` | Emergency contacts |
| PATCH · DELETE | `/students/:studentId/contacts/:contactId` | 🔑 `student.contact.write` | Edit / remove a contact |
| GET | `/students/:studentId/medical` | 🔑 `student.medical.read` | Encrypted medical record (read, audited) |
| PUT | `/students/:studentId/medical` | 🔑 `student.medical.write` ⬆️ | Update medical record (step-up) |

---

## Attendance 📦 `attendance`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/classes/:classId/attendance` | 🔑 `attendance.write` | Take the daily register (auto-notifies guardians on absence) |
| GET | `/classes/:classId/attendance` | 🔑 `attendance.read` | Class register history |
| GET | `/students/:studentId/attendance` | 🔑 `attendance.read` | A student's attendance |

---

## Fees & Billing 📦 `fees`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/fees/items` | 🔑 `fee.manage` | Fee catalog |
| PATCH | `/fees/items/:id` | 🔑 `fee.manage` | Edit a fee item |
| POST | `/invoices` | 🔑 `fee.manage` | Create an invoice |
| GET | `/invoices` · `/invoices/:id` | 🔑 `fee.read` | List / view invoices |
| POST | `/invoices/:id/issue` | 🔑 `fee.read` | Issue a DRAFT invoice |
| POST | `/invoices/:id/cancel` | 🔑 `fee.manage` | Cancel an invoice |
| POST · GET | `/invoices/:id/payments` | 🔑 `fee.manage` / `fee.read` | Record / list payments |
| POST | `/invoices/:id/pay/init` | 🔑 `fee.read` | Start hosted checkout — Paystack (NGN) or Stripe (USD invoices) |
| POST | `/invoices/:id/pay/confirm` | 🔑 `fee.read` | Verify-on-return: confirm a charge against the gateway if the webhook was lost (idempotent) |
| POST | `/payments/webhook` | 🌐 | Paystack webhook (HMAC-SHA512 verified; logs to `gateway_event`, dispatches disputes / subscription / admission / credits / prepay / dedicated-NUBAN / invoice) |
| GET | `/fees/payments/pending` | 🔑 `fee.read` | Payments awaiting maker-checker approval |
| POST | `/payments/:id/approve` · `/reject` | 🔑 `fee.approve` | Approve/reject large payment or refund |
| GET | `/payments/:id/receipt.pdf` | 🔑 `fee.read` | Numbered receipt PDF for a POSTED payment (family/staff scoped, audited) |
| GET | `/fees/reports` | 🔑 `fee.read` | Receivables aging + collection |
| POST | `/fees/reminders/run` | 🔑 `fee.manage` | Send fee reminders (also runs weekly per school, overdue-only) |
| POST | `/fees/reconciliation/run` | 🔑 `fee.reconcile.run` | Cross-tenant gateway reconciliation sweep (super_admin; also daily via BullMQ) |
| GET · PUT | `/invoices/:id/plan` | 🔑 `fee.read` / `fee.manage` | Installment plan (tranches must sum to total; states derived from payments) |
| GET | `/students/:id/credit` | 🔑 `fee.read` | Student credit balance + append-only ledger (self/guardian/staff) |
| POST | `/students/:id/prepay/init` | 🔑 `fee.read` | Prepay into the credit balance (hosted checkout) |
| POST | `/invoices/:id/apply-credit` | 🔑 `fee.manage` | Apply credit balance to an invoice (APPLIED entry + POSTED CREDIT payment) |
| POST | `/invoices/:id/overpayment-to-credit` | 🔑 `fee.manage` | Move overpaid excess to credit (double-entry: system REFUND + OVERPAYMENT) |
| GET · POST | `/students/:id/virtual-account` | 🔑 `fee.read` / `fee.manage` | Read / provision a dedicated NUBAN (transfers auto-credit the oldest open invoice) |
| GET · POST | `/invoices/:id/adjustments` | 🔑 `fee.manage` | List / request a discount-waiver (maker-checker) |
| POST | `/fees/adjustments/:id/decide` | 🔑 `fee.approve` | Approve/reject an adjustment (must differ from the requester) |
| GET · PUT | `/fees/late-fee-config` | 🔑 `fee.manage` (PUT ⬆️) | Per-school automatic late-fee policy (flat + grace days) |
| GET | `/fees/export/journal.csv` | 🔑 `fee.manage` | Posted-payments journal CSV (formula-guarded; audited) |
| GET | `/fees/disputes` · `/fees/disputes/:id` | 🔑 `fee.manage` | Gateway chargeback/dispute records (both gateways) |
| POST | `/fees/disputes/:id/respond` | 🔑 `fee.manage` | Record the school's evidence response on an OPEN dispute |

---

## Documents, report cards & certificates

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/documents` · `/documents/:id/confirm` | 🔑 `document.write` 📦 `documents` | Upload a document (presigned) |
| GET | `/documents` · `/:id` · `/:id/download` | 🔑 `document.read` 📦 `documents` | List / view / signed-download |
| DELETE | `/documents/:id` | 🔑 `document.read` 📦 `documents` | Remove a document |
| POST | `/reportcards/:studentId/generate` | 🔑 `grade.read` 📦 `documents` | Generate a report-card PDF (grades + attendance, **school logo embedded**); `?termId=` folds in that term's remarks |
| GET | `/reportcards/:studentId/remarks?termId=` | 🔑 `grade.read` 📦 `documents` | A term's class-teacher + head remarks (report-card scope) |
| PUT | `/reportcards/:studentId/remarks/class-teacher` | 🔑 `grade.write` 📦 `documents` | Class teacher (or staff) writes the class-teacher remark |
| PUT | `/reportcards/:studentId/remarks/head` | 🔑 `grade.read` 📦 `documents` | Principal / school_admin writes the head remark |
| POST | `/certificates/issue` | 🔑 `certificate.issue` 📦 `certificate` | Generate an ID card / certificate PDF (**school logo embedded**) |
| GET | `/certificates/history/:subjectId` | 🔑 `certificate.issue` 📦 `certificate` | Issuance history / reprint |
| POST · DELETE | `/schools/branding/logo` | 🔑 `school.branding.manage` | Upload / remove the school logo (PNG/JPEG, ≤1 MB) |
| POST | `/schools/branding/theme` | 🔑 `school.branding.manage` | Set brand colour + font |
| GET | `/schools/branding` | 🔑 `school.branding.manage` | Current branding |

---

## Timetabling 📦 `timetable`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/timetable/periods` | 🔑 `timetable.read` | Periods |
| PATCH | `/timetable/periods/:id` | 🔑 `timetable.write` | Edit a period |
| GET · POST | `/timetable/rooms` | 🔑 `timetable.read` | Rooms |
| PATCH | `/timetable/rooms/:id` | 🔑 `timetable.write` | Edit a room |
| POST | `/timetable/generate` | 🔑 `timetable.write` | Auto-generate a clash-free timetable |
| GET · POST | `/timetable/entries` | 🔑 `timetable.write` | Lesson grid (double-booking → 409) |
| PATCH · DELETE | `/timetable/entries/:id` | 🔑 `timetable.write` | Edit / delete a lesson |
| GET | `/timetable/classes/:classId` | 🔑 `timetable.read` | A class's weekly timetable |
| GET | `/timetable/cover?from=&to=` | 🔑 `timetable.read` | Lessons whose teacher is on approved leave, with any assigned cover |
| GET | `/timetable/cover/mine?from=&to=` | 🔑 `timetable.read` | The caller's own cover duties |
| POST | `/timetable/cover` | 🔑 `timetable.write` | Assign a reliever (self-cover 400, double-booking 409; reliever notified) |
| DELETE | `/timetable/cover/:id` | 🔑 `timetable.write` | Remove a cover assignment |

---

## HR & Payroll 📦 `hr`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · PUT | `/hr/me` | 🔑 `hr.self` | Staff self-service profile (encrypted personal/bank fields) |
| GET | `/hr/me/export` | 🔑 `hr.self` | Staff NDPR data export |
| POST | `/hr/me/erase-personal` | 🔑 `hr.self` | Erase self-service fields (retain statutory record) |
| GET | `/hr/employees` | 🔑 `hr.self` | Directory (list) |
| GET · PUT | `/hr/employees/:userId` | 🔑 `hr.read` | Employment record (salary encrypted; reads audited) |
| GET | `/hr/leave/types` · `/balances/me` · `/requests/me` | 🔑 `hr.self` | Leave types, own balance, own requests |
| POST | `/hr/leave/requests` | 🔑 `hr.self` | Apply for leave (routes through the workflow) |
| POST | `/hr/leave/types` | 🔑 `hr.self` | (setup) create a leave type |
| GET | `/hr/leave/requests` · `/calendar` | 🔑 `hr.leave.manage` | All requests + "who's out" calendar |
| POST | `/hr/payroll/runs` | 🔑 `hr.payroll.run` | Start a payroll run (snapshots salaries) |
| GET | `/hr/payroll/runs` · `/:id` | 🔑 `hr.read` | List / inspect runs |
| POST | `/hr/payroll/runs/:id/finalize` | 🔑 `hr.read` | Finalize a run (maker-checker: creator ≠ finalizer) |
| GET | `/hr/payroll/runs/:id/bank-export` | 🔑 `hr.payroll.run` | Bank-transfer CSV |
| GET | `/hr/payroll/runs/:id/payslips/:userId/pdf` | 🔑 `hr.read` | Payslip PDF |
| POST | `/hr/salary/employees/:employeeId/changes` | 🔑 `hr.salary.request` ⬆️ | Request a salary change |
| POST | `/hr/salary/changes/:id/decide` | 🔑 `hr.salary.approve` ⬆️ | Approve/reject (different person) |
| GET | `/hr/salary/changes` | 🔑 `hr.read` | Salary-change history |
| POST · PUT | `/hr/staff/:userId/appraisals` · `/appraisals/:id` · `/submit` | 🔑 `hr.appraisal.manage` | Performance appraisals |
| GET | `/hr/appraisals` · `/appraisals/me` | 🔑 `hr.appraisal.manage` | Appraisal lists |
| POST | `/hr/appraisals/:id/acknowledge` | 🔑 `hr.self` | Appraisee self-acknowledges |
| POST | `/hr/staff/:userId/disciplinary` | 🔑 `hr.self` | Open a disciplinary case |
| POST | `/hr/disciplinary/:id/entries` · `/status` | 🔑 `hr.disciplinary.manage` | Case entries / status |
| GET | `/hr/disciplinary` | 🔑 `hr.disciplinary.manage` | Disciplinary cases |
| POST | `/hr/staff/:userId/checklists` | 🔑 `hr.write` | On/offboarding checklists |
| GET | `/hr/staff/checklists` | 🔑 `hr.read` | Checklists |
| POST | `/hr/staff/checklist-items/:itemId/toggle` | 🔑 `hr.read` | Toggle a checklist task |
| POST | `/hr/staff/:userId/documents` | 🔑 `hr.write` | Staff documents (with expiry) |
| GET | `/hr/staff/documents` | 🔑 `hr.read` | Documents |
| POST | `/hr/staff/documents/reminders/run` | 🔑 `hr.read` | Doc-expiry reminder sweep |
| POST | `/hr/staff/:userId/training` | 🔑 `hr.write` | Training records |
| GET | `/hr/staff/training` | 🔑 `hr.read` | Training records |
| POST | `/hr/recruitment/requisitions` | 🔑 `hr.recruit.manage` | Job requisitions |
| GET | `/hr/recruitment/requisitions` | 🔑 `hr.recruit.manage` | Requisitions |
| POST | `/hr/recruitment/requisitions/:id/status` · `/applicants` | 🔑 `hr.recruit.manage` | Requisition status / add applicant |
| GET | `/hr/recruitment/applicants` | 🔑 `hr.recruit.manage` | Applicant pipeline |
| POST | `/hr/recruitment/applicants/:id/stage` | 🔑 `hr.recruit.manage` | Advance an applicant |
| POST | `/hr/recruitment/applicants/:id/convert` | 🔑 `hr.recruit.manage` ⬆️ | Convert applicant → User + Employee |
| GET | `/hr/analytics` | 🔑 `hr.read` | HR dashboard (headcount, leave, cost, expiries) |

---

## Facilities & operations

### Hostel 📦 `hostel`
| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/hostels` | 🔑 `hostel.read` | List / create boarding houses (create: admin-only; warden sees own, head_warden sees all) |
| GET | `/hostels/summary` | 🔑 `hostel.read` | Occupancy analytics (warden-scoped or school-wide) |
| PUT | `/hostels/:id` | 🔑 `hostel.manage` | Edit / rename a hostel (warden reassignment: admin-only) |
| DELETE | `/hostels/:id` | 🔑 `hostel.manage` | Delete an EMPTY hostel (admin-only; 409 while rooms exist) |
| POST | `/hostels/:id/rooms` · PUT `/hostels/rooms/:roomId` | 🔑 `hostel.manage` | Rooms |
| DELETE | `/hostels/rooms/:roomId` | 🔑 `hostel.manage` | Delete a room with NO allocation history (409 otherwise) |
| GET · POST | `/hostels/allocations` | 🔑 `hostel.read`/`manage` | Room allocations (capacity check is row-locked — no over-allocation under concurrency) |
| POST | `/hostels/allocations/:id/vacate` | 🔑 `hostel.manage` | Vacate a room |
| POST | `/hostels/fees/schedule` | 🔑 `hostel.manage` | Bill hostel rent — admins post directly; a (head-)warden's run becomes a FEE_SCHEDULE approval request (maker-checker) |

### Transport 📦 `transport`
| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/transport/vehicles` | 🔑 `transport.read` | Vehicles (driver sees own; head_driver sees the fleet) |
| GET | `/transport/summary` | 🔑 `transport.read` | Fleet analytics (driver-scoped or school-wide) |
| PUT | `/transport/vehicles/:id` | 🔑 `transport.manage` | Edit / rename a vehicle |
| DELETE | `/transport/vehicles/:id` | 🔑 `transport.manage` | Delete a vehicle no route uses (admin-only; 409 otherwise) |
| GET · POST | `/transport/routes` | 🔑 `transport.manage`/`read` | Routes |
| PUT | `/transport/routes/:id` | 🔑 `transport.manage` | Rename a route (assignments/stops/fees follow the id) |
| POST | `/transport/routes/:id/retire` · `/stops` | 🔑 `transport.manage` | Retire route / add stop |
| GET · POST | `/transport/assignments` | 🔑 `transport.manage`/`read` | Passenger assignments |
| POST | `/transport/assignments/:id/change-route` · `/cancel` | 🔑 `transport.manage` | Change route / cancel |
| POST | `/transport/fees/schedule` | 🔑 `transport.manage` | Bill transport fees — admins post directly; the head driver's run becomes a FEE_SCHEDULE approval request (maker-checker) |

### Library 📦 `library`
| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/library/books` | 🔑 `library.read` | Catalogue search / add |
| PUT | `/library/books/:id` | 🔑 `library.manage` | Edit / rename a book |
| DELETE | `/library/books/:id` | 🔑 `library.manage` | Delete a book with NO lending history (409 otherwise) |
| GET | `/library/books/export.csv` | 🔑 `library.manage` | Catalogue CSV |
| GET | `/library/loans` | 🔑 `library.read` | Loans |
| POST | `/library/loans/issue` | 🔑 `library.read` | Issue a loan (copy claim is atomic — no negative availability under concurrency) |
| POST | `/library/loans/:id/renew` · `/return` · `/pay-fine` | 🔑 `library.borrow` | Loan actions |
| GET | `/library/report` | 🔑 `library.manage` | Library report |

---

## Approvals (workflow engine) 📦 `workflow`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/workflows` | 🔑 `workflow.create` | Start a multi-stage approval request |
| POST | `/workflows/:id/submit` | 🔑 `workflow.create` | Submit for review |
| POST | `/workflows/:id/review` | 🔑 `workflow.review` | Approve/advance a stage (separation of duties) |
| POST | `/workflows/:id/veto` | 🔑 `workflow.veto` | Board veto |
| GET | `/workflows` · `/workflows/:id` | 🔑 `workflow.read` | List / inspect requests |

System-only types (raised by services, never the public create endpoint):
`LMS_CONTENT_PUBLISH`, `FEE_SCHEDULE`, `GRADE_PUBLISH`, `CBT_EXAM_PUBLISH`
(exam goes live only after a **different** `workflow.review` holder approves) and
`CBT_ANSWER_RELEASE` (answer key reaches students only after the **principal**
approves — single `workflow.review.principal` stage).

---

## Engagement & community

| Method | Path | Gate | Module | Purpose |
|---|---|---|---|---|
| GET · POST | `/tasks` | 🔑 `task.participate` | `task` | List / create tasks |
| PUT | `/tasks/:id/status` · `/me` | 🔑 `task.assign` | `task` | Task / assignment status |
| POST | `/tasks/:id/attachment/presign` · `/confirm` · `/comments` | 🔑 `task.participate` | `task` | Attachments + comments |
| GET | `/tasks/:id/assignments/:assignmentId/attachment` | 🔑 `task.participate` | `task` | Download attachment |
| GET · POST | `/polls` | 🔑 `poll.vote` | `poll` | List / create polls |
| POST | `/polls/:id/close` · `/vote` | 🔑 `poll.manage` | `poll` | Close / vote (anonymous) |
| GET · POST | `/discussion/groups` | 🔑 `discussion.participate` | `discussion` | Topic groups |
| GET | `/discussion/groups/:id/posts` | 🔑 `discussion.moderate` | `discussion` | Posts |
| POST | `/discussion/groups/:id/posts` · `/posts/:id/comments` | 🔑 `discussion.participate` | `discussion` | Post / comment |
| DELETE | `/discussion/posts/:id` · `/comments/:id` | 🔑 `discussion.participate`/`moderate` | `discussion` | Delete / moderate |
| GET · POST | `/forms` | 🔑 `form.respond` | `form` | List / create forms |
| POST | `/forms/:id/close` · `/respond` | 🔑 `form.manage` | `form` | Close / respond |
| GET | `/forms/:id/responses` | 🔑 `form.respond` | `form` | Tallies (anonymous) |
| GET · POST | `/discipline/complaints` | 🔑 `discipline.file` | `discipline` | Complaints |
| POST | `/discipline/complaints/:id/assign` | 🔑 `discipline.file` | `discipline` | Assign a handler |
| POST | `/discipline/complaints/:id/entries` · `/resolve` | 🔑 `discipline.manage` | `discipline` | Append-only entries / resolution |
| POST · GET | `/discipline/complaints/:id/evidence/*` | 🔑 `discipline.manage` | `discipline` | Evidence upload/download |
| GET · POST | `/alumni` | 🔑 `alumni.manage` | `alumni` | Alumni records |
| PUT | `/alumni/:id` · POST `/alumni/broadcast` | 🔑 `alumni.manage` | `alumni` | Edit / broadcast |

---

## Communication

| Method | Path | Gate | Module | Purpose |
|---|---|---|---|---|
| GET | `/messages/contacts` · `/threads` | 🔑 `message.send` | `messaging` | Who I can message / my threads |
| GET · POST | `/messages/threads/:id` · `/threads` | 🔑 `message.read` | `messaging` | Read / start a thread |
| POST | `/messages/threads/:id/reply` | 🔑 `message.send` | `messaging` | Reply |
| GET · POST | `/events` | 🔑 `event.read` | `calendar` | School events |
| DELETE | `/events/:id` | 🔑 `event.write` | `calendar` | Delete an event |
| GET · POST | `/announcements` | 🔑 `announcement.read` | — | Announcements |
| DELETE | `/announcements/:id` | 🔑 `announcement.manage` | — | Delete an announcement |
| GET | `/notifications` | 🔑 `notification.read` | — | In-app inbox |
| POST | `/notifications/:id/read` · `/notifications` | 🔑 `notification.read` | — | Mark read / send |
| GET · PUT | `/notifications/me/phone` | 🔑 `notification.read` | — | Own SMS/WhatsApp delivery number |
| GET · PUT | `/notifications/me/preferences` | 🔑 `notification.read` | — | Own external-channel prefs (email/SMS/WhatsApp toggles + per-type mutes). In-app inbox always delivered; essential types ignore mutes |
| GET · POST | `/meetings/slots/mine` · `/meetings/slots` | 🔑 `meeting.host` | — | A host's own appointment slots / open one |
| DELETE | `/meetings/slots/:id` | 🔑 `meeting.host` | — | Withdraw an unbooked slot (409 if booked) |
| GET | `/meetings/slots/open` | 🔑 `meeting.book` | — | Bookable slots (future, not full) |
| GET · POST | `/meetings/bookings/mine` · `/meetings/bookings` | 🔑 `meeting.book` | — | Own bookings / book for OWN child (403 otherwise; full slot → 409) |
| DELETE | `/meetings/bookings/:id` | 🔑 `meeting.book` | — | Cancel (booking parent, host teacher or staff-wide); other party notified |

---

## Admin, directory, admissions, analytics, privacy

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/admin/roles` · `/admin/users` | 🔑 `rbac.manage` | Roles + user list |
| POST | `/admin/users` · `/admin/users/:userId/roles` | 🔑 `rbac.manage` | Create user / assign role. Grants touching the junior-admin tier (role `junior_admin`, or any role for a user holding it) return `{ pendingApproval: true, requestId }` — an ADMIN_APPOINTMENT workflow a DIFFERENT senior must approve |
| DELETE | `/admin/users/:userId/roles/:roleName` | 🔑 `rbac.manage` | Remove a role. 409 on removing your OWN school_admin/principal role or the school's LAST managing role |
| POST | `/admin/import/students` | 🔑 `rbac.manage` | Legacy bulk import |
| GET | `/admin/students/import/template` | 🔑 `student.import` | CSV import template |
| POST | `/admin/students/import` | 🔑 `student.import` | Upload a PENDING import batch |
| GET | `/admin/students/import` · `/:id` | 🔑 `student.import` | List / inspect batches |
| POST | `/admin/students/import/:id/approve` · `/reject` | 🔑 `student.import` | Approve (approver ≠ uploader) — creates accounts with UNIQUE one-time temp passwords, returned ONCE as `credentials` (forced password change at first login) / reject |
| GET | `/directory/search` | 🔑 `directory.search` | Cross-role people search (CROSS-SCHOOL registry) |
| GET | `/search?q=` | (auth) | **In-tenant** global omnibox — students / staff / classes / invoices. Each category included only if the caller holds its read permission; students relationship-scoped (a parent sees only their own children, never another family) |
| GET · PUT | `/admin/security/mfa-policy` | 🔑 `rbac.manage` (PUT ⬆️) | Per-school "require MFA for all staff" policy (staff = any role but student/parent; super_admin exempt) |
| POST | `/public/admissions` | 🌐 📦 `admissions` | Public admissions application |
| GET | `/admissions` · `/admissions/:id` | 🔑 `admission.review` 📦 `admissions` | Application review queue |
| POST | `/admissions/:id/review` · `/exam` | 🔑 `admission.review` 📦 `admissions` | Decide / schedule entrance exam |
| GET | `/analytics/overview` | 📦 `analytics` | Role-scoped analytics (attendance, grades, fees, demographics) |
| GET | `/privacy/export/:studentId` | (auth) | NDPR data-subject export bundle |
| POST · GET | `/privacy/erasure` | (auth) | Request / list right-to-erasure |
| POST | `/privacy/erasure/:id/review` | 🔑 `privacy.erasure.review` | Controller review of an erasure request |

---

## Exam logistics (physical exams)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/exams/mine` | 🔑 `timetable.read` | A student's (or their children's) upcoming exams — hall, time, **seat number** |
| GET | `/exams/invigilations/mine` | 🔑 `timetable.read` | The caller's own invigilation duties |
| GET · POST | `/exams` | 🔑 `exam.manage` | List / schedule a sitting (hall, date, time, capacity) |
| DELETE | `/exams/:id` | 🔑 `exam.manage` | Remove a sitting (cascades seats + roster) |
| GET · POST | `/exams/:id/seats` | 🔑 `exam.manage` | Seating plan / seat a student list or a whole class (seat 1..N; over capacity → 409) |
| GET · POST | `/exams/:id/invigilators` | 🔑 `exam.manage` | Roster / assign an invigilator (staff only — a student is refused; assignee notified) |
| DELETE | `/exams/:id/invigilators/:staffId` | 🔑 `exam.manage` | Remove from the roster |

---

## Games 📦 `games`

All game tables are tenant-scoped + RLS, relationship-scoped (404-not-403),
audited, and server-authoritative (secrets/answers/moves validated server-side;
never trusted from the client). Pure logic lives in `@sms/game-engine`.

### Dead & Wounded (number-guessing family)

| Area | Endpoints | Gate | Purpose |
|---|---|---|---|
| Duel | `POST /games` · `GET /games/open` · `GET /games/:id` · `POST /games/:id/{join,secret,guess,forfeit}` | 🔑 `game.play` | 2-player number-guessing duel |
| Elimination Ring | `POST /rings` · `GET /rings/:id` · `POST /rings/:id/{join,start,secret,guess,timeout,forfeit,end}` | 🔑 `game.play` | N-player elimination ring |
| Class Race | `POST /races` · `GET /races` · `GET /races/:id` · `POST /races/:id/{join,start,guess,end}` | 🔑 `game.race.open` / `game.play` / `game.leaderboard.read` | Parallel class race |
| Race tournament | `POST /race-tournaments` · `GET /race-tournaments/:id` | 🔑 `game.race.open` / `leaderboard.read` | Cross-class race tournament |
| League / Knockout | `POST /competitions` · `GET /competitions` · `/:id` · `POST /:id/{start,sweep,cancel}` | 🔑 `game.league.create` / `leaderboard.read` | Round-robin / bracket |
| Ultimate (cross-school) | `POST /ultimate/competitions` · `/:id/{cancel,enroll,enter,guess}` · `PUT /ultimate/consent` · `GET /ultimate/competitions` · `/:id/{leaderboard,me}` | 🔑 `game.ultimate.admin` / `enroll` / `play` / `leaderboard.read` | Cross-school arena (two-tier consent) |
| Settings | `GET · PUT /game-settings` | 🔑 `game.leaderboard.read` / `game.settings.manage` | Per-school game config |

### Classroom games

Curriculum-themed engagement games. The first three are **class-hosted** (a
teacher hosts for a class; enrolled students play). Difficulty = EASY/MEDIUM/HARD.

| Area | Endpoints | Gate | Purpose |
|---|---|---|---|
| Live Quiz | `POST · GET /quizzes` · `GET · PUT · DELETE /quizzes/:id` · `POST /quiz-sessions` · `GET /quiz-sessions` · `GET /quiz-sessions/:id` · `POST /quiz-sessions/:id/{join,next,answer,end}` | 🔑 `game.quiz.host` (author/host) / `game.play` (join/answer) / `game.leaderboard.read` | Kahoot-style themed quiz (Geography/Science/Art/Literature/General). Speed-scored; correct answer hidden from players until a question closes. DELETE = soft-archive. |
| Hangman | `POST · GET /hangman` · `GET /hangman/:id` · `POST /hangman/:id/{join,start,guess,end}` | 🔑 `game.hangman.host` / `game.play` / `game.leaderboard.read` | Letter-guessing; word server-only while live, revealed on finish. Difficulty sets lives. |
| Typing Race | `POST · GET /typing-races` · `GET /typing-races/:id` · `POST /typing-races/:id/{join,start,progress,end}` | 🔑 `game.typing.host` / `game.play` / `game.leaderboard.read` | Passage typing; net WPM computed server-side from reported text + server-measured elapsed. |
| Checkers | `POST · GET /checkers` · `GET /checkers/:id` · `POST /checkers/:id/{join,move,resign,claim-time}` | 🔑 `game.play` / `game.leaderboard.read` | 2-player 8×8 draughts (peer duel). Moves engine-validated. |
| Chess | `POST · GET /chess` · `GET /chess/:id` · `POST /chess/:id/{join,move,resign,claim-time}` | 🔑 `game.play` / `game.leaderboard.read` | Full-rules 2-player chess (peer duel): check/mate/stalemate/draw, castling, en passant, promotion. |

Board games (checkers/chess) carry a **per-player chess clock** — difficulty sets
the time control (Classical 15+10 / Rapid 5+5 / Blitz 3+2); a move deducts the
turn's elapsed time and adds the increment, a flag-fall loses, and `claim-time`
lets the opponent claim once the mover's clock hits zero.

---

## CBT exam hall 📦 `cbt`

WAEC/JAMB-style timed, auto-marked mock exams. **Server authority is absolute:**
a question's `answerIndex` never reaches a student while their sitting is open;
the exam window and duration are enforced server-side from the sitting's own
`startedAt`; question sampling/shuffling is server-side. Governance is
maker-checker end to end: a teacher authors only for subjects they teach
(`classSubjectTeacher` is authoritative; school_admin/principal are school-wide),
publishing requires a **different** reviewer's approval (`CBT_EXAM_PUBLISH`), and
the answer key reaches students only after the teacher requests release **and**
the principal approves (`CBT_ANSWER_RELEASE`). A closed sitting shows its score
immediately; correct answers stay withheld until release.

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/cbt/authoring-options` | 🔑 `cbt.manage` | The caller's authoring scope: their taught subjects/classes (teacher) or all (school-wide staff) — feeds the web pickers |
| GET | `/cbt/banks` | 🔑 `cbt.manage` | List question banks (teacher: own + taught-subject banks; admin: all) |
| POST | `/cbt/banks` | 🔑 `cbt.manage` | Create a bank — `subjectId` REQUIRED for teachers and must be a subject they teach (404 otherwise) |
| POST | `/cbt/banks/:id/questions` | 🔑 `cbt.manage` | Add questions (typed rows from the Kahoot-style form or bulk paste; 2–6 choices, server-validated `answerIndex`) |
| POST | `/cbt/exams` | 🔑 `cbt.manage` | Create an exam (DRAFT) over a bank — a teacher must target a class where they teach the bank's subject |
| POST | `/cbt/exams/:id/request-publish` | 🔑 `cbt.manage` | Maker-checker: park DRAFT → PENDING_APPROVAL + raise `CBT_EXAM_PUBLISH` (approver ≠ author, engine-enforced) |
| POST | `/cbt/exams/:id/request-answer-release` | 🔑 `cbt.manage` | Maker-checker: request the answer key (only once CLOSED / window ended) → principal approves `CBT_ANSWER_RELEASE` |
| PUT | `/cbt/exams/:id/status` | 🔑 `cbt.manage` | Close a live exam early (`CLOSED` only — publishing goes through approval) |
| GET | `/cbt/exams/all` | 🔑 `cbt.manage` | Staff: every exam, all statuses |
| GET | `/cbt/exams/:id/results` | 🔑 `cbt.manage` | Per-exam results table (names + scores; audited read) |
| GET | `/cbt/exams` | 🔑 `cbt.take` | Student: PUBLISHED exams open to them (class-scoped, window-live) |
| POST | `/cbt/exams/:id/start` | 🔑 `cbt.take` | Start (or resume) the caller's sitting — server samples + fixes the question order |
| GET | `/cbt/sittings/:id` | 🔑 `cbt.take` | Own sitting view (auto-expires on read past the deadline); `answerIndex` present only when finished AND released |
| POST | `/cbt/sittings/:id/answer` | 🔑 `cbt.take` | Save one answer (refused after time is up — the clock is server law) |
| POST | `/cbt/sittings/:id/submit` | 🔑 `cbt.take` | Submit + auto-mark (idempotent) |

---

## Realtime (WebSocket — not HTTP)

The `GameSocketGateway` runs `ws` on the same HTTP server under `/ws/*`:

- `/ws/duel` · `/ws/ring` · `/ws/race` · `/ws/arena` — in-memory step-2 game transport.
- `/ws/watch?mode={duel|ring|race|league|ultimate}&gameId=…` — durable, RLS-scoped, viewer-redacted spectator bridge; re-reads the same view the mode's HTTP GET returns.

Handshake auth: HS256 `?token=` minted by the web BFF (`GET /api/ws-ticket`).

---

*Generated from the NestJS controllers. To regenerate, parse `apps/api/src/**/*.controller.ts` for `@Controller` + `@Get/@Post/@Put/@Patch/@Delete` and the `@RequirePermission` / `@RequireModule` / `@RequireStepUp` / `@Public` decorators.*
