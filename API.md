# API Reference — School Management System

Complete HTTP endpoint reference for the NestJS API (`apps/api`). **354 endpoints across 56 controllers.**

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
| POST | `/auth/login` | 🌐 | Verify credentials + MFA + account-lockout, return the signed session JWT + modules |
| GET | `/health` | 🌐 | Liveness/readiness probe |
| GET | `/metrics` | 🌐 (bearer/`x-metrics-token`) | Prometheus metrics scrape (process + HTTP + per-tenant counters) |
| GET | `/public/schools` | 🌐 | Public list of onboarded schools (parent directory; excludes the platform org) |
| POST | `/public/onboarding-requests` | 🌐 | A prospective school requests to join (homepage CTA) |
| GET | `/public/schools/:slug/branding` | 🌐 | A school's login-page logo + theme by slug (hidden when subscription lapsed) |

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
| GET | `/operator/tenants` | | Cross-tenant school registry (plan + module count) |
| GET | `/operator/analytics` | | Graphical platform business metrics (MRR, ARPA, growth, funnel, churn, module adoption, demographics) |
| GET | `/operator/audit` | | Cross-tenant audit trail, actor-attributed (email + unique id + roles), cursor-paginated |
| GET | `/operator/audit/export.csv` | | Downloadable CSV audit report (formula-injection safe) |
| POST | `/operator/impersonate` | ⬆️ | Mint an audited, scoped impersonation token |
| GET | `/operator/tenants/:schoolId/subscription` | | A school's subscription (plan + modules) |
| PUT | `/operator/tenants/:schoolId/subscription` | | Set plan + per-module overrides / comp status |
| GET | `/operator/onboarding-requests` | | Review queue of public onboarding requests |
| POST | `/operator/onboarding-requests/:id/status` | | Approve / reject / mark-reviewing a request |
| GET | `/operator/tenants/:schoolId/students` | | Cross-tenant enrolled-student view |
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
| GET | `/billing` | 🔑 `billing.read` | Current plan + per-seat pricing quote |
| POST | `/billing/checkout/init` | 🔑 `billing.read` ⬆️ | Start Paystack checkout for a chosen tier |
| POST | `/billing/dunning/run` | 🔑 `billing.dunning.run` | Manual delinquency sweep (flips elapsed subs to PAST_DUE) |

---

## LMS — classes, subjects, enrollment, promotion 📦 `lms`

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/classes` | 🔑 `class.write` | Create a class |
| PUT | `/classes/:classId` | 🔑 `class.write` | Edit a class (level / next-class / supervisor) |
| POST | `/subjects` | 🔑 `subject.manage` | Create a subject in the school catalog |
| GET | `/subjects` | 🔑 `class.read` | List subjects |
| POST | `/classes/:classId/subjects` | 🔑 `class.read` | Assign a teacher to a class-subject |
| GET | `/classes/:classId/subjects` | 🔑 `class.read` | List a class's subject-teacher offerings |
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
| POST | `/invoices/:id/pay/init` | 🔑 `fee.read` | Start Paystack hosted checkout |
| POST | `/payments/webhook` | 🌐 | Paystack webhook (HMAC-SHA512 verified) |
| GET | `/fees/payments/pending` | 🔑 `fee.read` | Payments awaiting maker-checker approval |
| POST | `/payments/:id/approve` · `/reject` | 🔑 `fee.approve` | Approve/reject large payment or refund |
| GET | `/fees/reports` | 🔑 `fee.read` | Receivables aging + collection |
| POST | `/fees/reminders/run` | 🔑 `fee.manage` | Send fee reminders |

---

## Documents, report cards & certificates

| Method | Path | Gate | Purpose |
|---|---|---|---|
| POST | `/documents` · `/documents/:id/confirm` | 🔑 `document.write` 📦 `documents` | Upload a document (presigned) |
| GET | `/documents` · `/:id` · `/:id/download` | 🔑 `document.read` 📦 `documents` | List / view / signed-download |
| DELETE | `/documents/:id` | 🔑 `document.read` 📦 `documents` | Remove a document |
| POST | `/reportcards/:studentId/generate` | 🔑 `grade.read` 📦 `documents` | Generate a report-card PDF (grades + attendance, **school logo embedded**) |
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
| GET · POST | `/hostels` | 🔑 `hostel.read` | List / create boarding houses |
| PUT | `/hostels/:id` | 🔑 `hostel.manage` | Edit a hostel |
| POST | `/hostels/:id/rooms` · PUT `/hostels/rooms/:roomId` | 🔑 `hostel.manage` | Rooms |
| GET · POST | `/hostels/allocations` | 🔑 `hostel.read`/`manage` | Room allocations |
| POST | `/hostels/allocations/:id/vacate` | 🔑 `hostel.manage` | Vacate a room |
| POST | `/hostels/fees/schedule` | 🔑 `hostel.manage` | Bill hostel rent as invoice line items |

### Transport 📦 `transport`
| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/transport/vehicles` | 🔑 `transport.read` | Vehicles |
| PUT | `/transport/vehicles/:id` | 🔑 `transport.manage` | Edit a vehicle |
| GET · POST | `/transport/routes` | 🔑 `transport.manage`/`read` | Routes |
| POST | `/transport/routes/:id/retire` · `/stops` | 🔑 `transport.manage` | Retire route / add stop |
| GET · POST | `/transport/assignments` | 🔑 `transport.manage`/`read` | Passenger assignments |
| POST | `/transport/assignments/:id/change-route` · `/cancel` | 🔑 `transport.manage` | Change route / cancel |
| POST | `/transport/fees/schedule` | 🔑 `transport.manage` | Bill transport fees |

### Library 📦 `library`
| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET · POST | `/library/books` | 🔑 `library.read` | Catalogue search / add |
| PUT | `/library/books/:id` | 🔑 `library.manage` | Edit a book |
| GET | `/library/books/export.csv` | 🔑 `library.manage` | Catalogue CSV |
| GET | `/library/loans` | 🔑 `library.read` | Loans |
| POST | `/library/loans/issue` | 🔑 `library.read` | Issue a loan |
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

---

## Admin, directory, admissions, analytics, privacy

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/admin/roles` · `/admin/users` | 🔑 `rbac.manage` | Roles + user list |
| POST | `/admin/users` · `/admin/users/:userId/roles` | 🔑 `rbac.manage` | Create user / assign role |
| DELETE | `/admin/users/:userId/roles/:roleName` | 🔑 `rbac.manage` | Remove a role |
| POST | `/admin/import/students` | 🔑 `rbac.manage` | Legacy bulk import |
| GET | `/admin/students/import/template` | 🔑 `student.import` | CSV import template |
| POST | `/admin/students/import` | 🔑 `student.import` | Upload a PENDING import batch |
| GET | `/admin/students/import` · `/:id` | 🔑 `student.import` | List / inspect batches |
| POST | `/admin/students/import/:id/approve` · `/reject` | 🔑 `student.import` | Approve (create accounts, maker-checker) / reject |
| GET | `/directory/search` | 🔑 `directory.search` | Cross-role people search |
| POST | `/public/admissions` | 🌐 📦 `admissions` | Public admissions application |
| GET | `/admissions` · `/admissions/:id` | 🔑 `admission.review` 📦 `admissions` | Application review queue |
| POST | `/admissions/:id/review` · `/exam` | 🔑 `admission.review` 📦 `admissions` | Decide / schedule entrance exam |
| GET | `/analytics/overview` | 📦 `analytics` | Role-scoped analytics (attendance, grades, fees, demographics) |
| GET | `/privacy/export/:studentId` | (auth) | NDPR data-subject export bundle |
| POST · GET | `/privacy/erasure` | (auth) | Request / list right-to-erasure |
| POST | `/privacy/erasure/:id/review` | 🔑 `privacy.erasure.review` | Controller review of an erasure request |

---

## Dead & Wounded games 📦 `games`

| Area | Endpoints | Gate | Purpose |
|---|---|---|---|
| Duel | `POST /games` · `GET /games/open` · `GET /games/:id` · `POST /games/:id/{join,secret,guess,forfeit}` | 🔑 `game.play` | 2-player number-guessing duel |
| Elimination Ring | `POST /rings` · `GET /rings/:id` · `POST /rings/:id/{join,start,secret,guess,timeout,forfeit,end}` | 🔑 `game.play` | N-player elimination ring |
| Class Race | `POST /races` · `GET /races` · `GET /races/:id` · `POST /races/:id/{join,start,guess,end}` | 🔑 `game.race.open` / `game.play` / `game.leaderboard.read` | Parallel class race |
| Race tournament | `POST /race-tournaments` · `GET /race-tournaments/:id` | 🔑 `game.race.open` / `leaderboard.read` | Cross-class race tournament |
| League / Knockout | `POST /competitions` · `GET /competitions` · `/:id` · `POST /:id/{start,sweep,cancel}` | 🔑 `game.league.create` / `leaderboard.read` | Round-robin / bracket |
| Ultimate (cross-school) | `POST /ultimate/competitions` · `/:id/{cancel,enroll,enter,guess}` · `PUT /ultimate/consent` · `GET /ultimate/competitions` · `/:id/{leaderboard,me}` | 🔑 `game.ultimate.admin` / `enroll` / `play` / `leaderboard.read` | Cross-school arena (two-tier consent) |
| Settings | `GET · PUT /game-settings` | 🔑 `game.leaderboard.read` / `game.settings.manage` | Per-school game config |

---

## Realtime (WebSocket — not HTTP)

The `GameSocketGateway` runs `ws` on the same HTTP server under `/ws/*`:

- `/ws/duel` · `/ws/ring` · `/ws/race` · `/ws/arena` — in-memory step-2 game transport.
- `/ws/watch?mode={duel|ring|race|league|ultimate}&gameId=…` — durable, RLS-scoped, viewer-redacted spectator bridge; re-reads the same view the mode's HTTP GET returns.

Handshake auth: HS256 `?token=` minted by the web BFF (`GET /api/ws-ticket`).

---

*Generated from the NestJS controllers. To regenerate, parse `apps/api/src/**/*.controller.ts` for `@Controller` + `@Get/@Post/@Put/@Patch/@Delete` and the `@RequirePermission` / `@RequireModule` / `@RequireStepUp` / `@Public` decorators.*
