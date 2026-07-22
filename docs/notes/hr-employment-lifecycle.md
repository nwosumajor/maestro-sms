# HR employment lifecycle

> HR program Phase 5 — contract & confirmation lifecycle (probation→confirmation, promotion, renewal maker-checker; contract-expiry sweep); RLS file 61; live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 5 (feature #8 contract & confirmation lifecycle)** — built 2026-07-12, live-verified, **UNCOMMITTED**.

`employee` gained `confirmationStatus` (default CONFIRMED — sane backfill; new hires with `probationMonths` 1-24 on the upsert start PROBATION + computed `probationEndsAt`), `gradeLevel`, `contractReminderSentAt`. New table **`employment_change_request`** (type CONFIRMATION|PROMOTION|RENEWAL + payload + PENDING/APPROVED/REJECTED): migration `20260819000000_employment_lifecycle`, RLS `61_employment_lifecycle_rls.sql` (SELECT/INSERT/UPDATE, **no DELETE — the rows ARE the employment history**, like salary changes; sentinel `employment_change_request_update`), entrypoint-registered, RLS-e2e case (127/127). Applied to live DB.

`EmploymentService` (`/hr/employment/changes`): request (hr.write; validates — CONFIRMATION only for PROBATION employees, PROMOTION needs title/grade, RENEWAL must EXTEND the current endDate; one PENDING per (user,type)); decide (hr.salary.approve, **≠ requester** — no step-up, it's not money). Approval APPLIES in the same tx: CONFIRMATION → CONFIRMED + probationEndsAt cleared; PROMOTION → jobTitle/gradeLevel (**salary untouched — pay goes through the salary maker-checker separately**); RENEWAL → endDate + **re-arms `contractReminderSentAt`**. `StaffReminderService.sweep` extended with `sweepContracts`: ACTIVE employees with endDate ≤ 30d and no stamp → notify each school's HR ("renew or start offboarding") + stamp — same privileged cross-tenant pattern as the doc-expiry sweep (disabled locally without DATABASE_RETENTION/MIGRATE_URL; code path mirrors the verified doc sweep).

Web: `EmploymentLifecycle` card on `/hr/staff/[userId]` (status badges: probation/confirmed + probation end + grade + contract end; request form per type; pending approve/reject for hr.salary.approve); EmployeeForm-adjacent upsert accepts gradeLevel/probationMonths (API-side; form fields can be added later). EmployeeDto += confirmationStatus/probationEndsAt/gradeLevel/endDate.

Verified live: hire on 3-month probation w/ GL-07 + fixed term; confirmation: dup-pending 400, self-decide 403, principal approves → CONFIRMED + probation cleared; promotion → title/grade updated, **salary unchanged**; renewal: shortening 400, extension applied 2026-08-01→2027-08-01; confirm-a-confirmed 400; history = 3 APPROVED rows. RLS 127/127, api+web tsc 0, route smoke green.

HR program 8/15 (#1-#8). Next: **#9 exit management** (resignation/termination → final settlement calc (leave payout, loan recovery) → offboarding checklist → deactivation), then Tier 3 (#10-#14) + #15 biometric ingestion.
