# Enterprise feature expansion

> Status of the large add-on-module build program (Hostel/Transport/Library/Task/Poll/etc.)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

User asked for a big batch of new modules (feature-parity with a commercial SMS). Building each as a complete vertical slice following the established pattern: schema (`packages/db/prisma/schema/<m>.prisma`) → RLS (`prisma/rls/NN_*.sql` + register in `docker-entrypoint.sh`) → migration → perms (`@sms/types/permissions/<m>.ts` + add to `all.ts` union + seed) → DTO (`@sms/types/dto/<m>.ts` + barrel) → service (relationship-scoped, audited) → controller → module (register in `app.module.ts`) → RLS-e2e cross-tenant cases (id decl + seed insert + FK-ordered cleanup + cases array — coverage gate enforces) → unit test → web page+component (`postSms` from `play-ui`, nav item in `AppShell` + NavKey + `PLATFORM_OWNER_NAV` untouched + middleware matcher) → live smoke. New fee-bearing modules bill via the SHARED Fees tables (Invoice/InvoiceLineItem) so they collect ALONGSIDE academic fees (reuse a student's DRAFT invoice).

**DONE + verified (live DB on port 5434, 59 suites/388 tests):**
- **Hostel** (`hostel`/`hostel_room`/`hostel_allocation`, migration `20260713`, RLS 36): rent/custom-fields/availability/warden/allocate/schedule-fees. `hostel.read`/`hostel.manage`.
- **Transport** (`vehicle`/`transport_route`/`route_stop`/`transport_assignment`, migration `20260714`, RLS 37): vehicles+custom fields, routes/stops (FLAT or STOP fare), seat-gated assign, route-change→parent alert (NotificationService), schedule-fees. `transport.read`/`transport.manage`.
- **Library** (`library_book`/`book_loan`, migration `20260715`, RLS 38): barcode catalogue, issue/renew/return, overdue fines (₦50/day, MAX_RENEWALS=2, LOAN_DAYS=14) + receipts, CSV export (StreamableFile), reports. `library.read`/`library.borrow`(students)/`library.manage`(librarian).

**ALL DONE + verified** (65 suites/435 tests; migrations 20260713–20260722; RLS 36–45):
- **Task** (task/task_assignment/task_comment, RLS 39): assign to staff/students, upload, status, comments. `task.assign`/`task.participate`.
- **Poll** (poll/poll_option/poll_vote, RLS 40): ANONYMOUS — voterId never joined to optionId; results are groupBy tallies; voters blind until close. `poll.manage`/`poll.vote`.
- **Discussion** (discussion_group/post/comment, RLS 41): audience groups, soft-delete moderation (tombstone). `discussion.participate`/`discussion.moderate`.
- **Discipline** (discipline_complaint/assignee/evidence/entry, RLS 42): file→assign→evidence→resolve; human-only (GR#8); self-scope 404. `discipline.file`/`discipline.manage`.
- **Timed exams**: assessment.timed/durationMinutes/opensAt/closesAt + submission.startedAt (migration 20260720, no new table). `POST .../start` + submit enforces deadline server-side.
- **Auto-timetable**: pure solver `apps/api/src/timetable/auto-timetable.ts` (no class/teacher double-book) + `POST /timetable/generate`. 4 unit tests.
- **Certificate** (issued_certificate append-only, RLS 43): pdfkit ID cards + certificates, serial-logged. `certificate.issue`.
- **Alumni** (alumnus, RLS 44): records + broadcast via Notifications. `alumni.manage`.
- **Form builder** (form/form_response, RLS 45): JSON field schema, audience, ANONYMOUS responses (like polls). `form.manage`/`form.respond`.
- **Theming**: school_branding gained brandHue/brandSat/brandLight/fontFamily; `POST /schools/branding/theme`; AppShell fetches + applies (color + font); picker in BrandingManager.
- **Fee reminders**: `FeesService.sendFeeReminders` + `POST /fees/reminders/run?overdueOnly=` notifies guardians of outstanding invoices.
- **Live SMS**: `TwilioChannelProvider` bound when `SMS_PROVIDER=twilio` (SMS via Twilio fetch; degrades to log-only without TWILIO_* creds).
- **Report Center**: `/reports` web hub linking every permission-gated report.

The full suggested-functionality program is COMPLETE. See [platform-owner-org-model](platform-owner-org-model.md). NOTE: live DB recreated on schema change — demo data ephemeral.
