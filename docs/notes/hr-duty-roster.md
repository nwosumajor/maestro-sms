# HR duty roster

> HR program Phase 4 — duty rostering for non-timetabled staff (bulk dated shifts, notify, my-duties); RLS file 60; live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**HR enhancement program Phase 4 (feature #7 duty rostering)** — built 2026-07-12, live-verified, **UNCOMMITTED**.

One new table **`duty_assignment`** (userId/date/title/startTime/endTime "HH:MM"/note/assignedById): migration `20260818000000_duty_roster`, RLS `60_duty_roster_rls.sql` (**full CRUD — a roster is a PLAN, not a ledger**; unassign = audited DELETE; sentinel `duty_assignment_delete`), entrypoint-registered, RLS-e2e case added (coverage gate green, suite 126/126). Applied to live DB.

`DutyService` (+`DutyController`, `/hr/duty`): `assign` — **bulk staff[] × dates[]** in one call (cap 200 rows/call; validates HH:MM via attendance.util's hhmmToMinutes; all staff must have ACTIVE employee records → 404; assignees **notified** best-effort outside the tx, mirroring the LMS badge pattern); `list?from&to` (hr.read); `mine` (hr.self — from a week back, 30 max); `remove` (hr.write, audited delete). All mutations audited; DTO `DutyAssignmentDto`.

Web: `DutyRoster` component on the **/hr/attendance** page (the "presence hub" — staff picker chips come from the register's ACTIVE-employee rows; comma-sep dates; next-2-weeks list w/ unassign) + `MyDuties` on /leave (hidden when empty, keeps the page uncluttered).

Verified live: bulk 2 staff × 2 dates → 4 rows; bad time 400; ghost staff 404; roster range view w/ names; teacher sees only own duties, 403 on whole-roster + assign; **"Duty assigned" notification landed in the assignee's inbox**; unassign 200 → count drops. api+web tsc 0, route smoke 69 routes, RLS 126/126.

Phases done: [hr-money-cluster](hr-money-cluster.md) [hr-runtypes-remittance](hr-runtypes-remittance.md) [hr-staff-attendance](hr-staff-attendance.md) + this. HR program 7/15 (#1-#7). Next: **#8 contract & confirmation lifecycle** (probation→confirmation maker-checker, fixed-term expiry riding the reminder sweep, promotion→salary-change link), **#9 exit management**, then Tier 3 (#10 letters, #11 org chart, #12 TRCN, #13 careers page, #14 analytics v2) + #15 biometric ingestion.
