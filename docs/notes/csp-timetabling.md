# CSP timetabling

> CSP timetable auto-generation BUILT (2026-07-20): real backtracking solver (MRV + step budget + MRV-greedy fallback) over per-offering quotas, teacher_unavailability (rls/77), preferred rooms; diagnostics + web console; 95 suites/749 tests + live compose smoke green; COMMITTED 2c66a2b (backend) + 45a7bbf (web), not yet pushed

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Upgraded the old greedy `auto-timetable.ts` into a real CSP (2026-07-20), replacing
the stale "CSP auto-generation is future" note (CLAUDE.md updated).

- **Pure solver** (`apps/api/src/timetable/auto-timetable.ts`): backtracking + MRV
  + 200k step budget; hard constraints = class/teacher/preferred-room no-double-book
  + teacher unavailability; soft spread (same class+subject not twice a day) via
  value ordering. Preflight diagnostics (TEACHER/CLASS/ROOM_OVERLOAD with
  demand/capacity) skip the search when demand is structurally impossible.
  Fallback is **dynamic-MRV greedy** (most-constrained lesson first) — plain
  hardest-first greedy let an unconstrained lesson squat on a constrained
  teacher's only slot (caught live by the e2e). 12 unit tests.
- **Inputs**: `class_subject_teacher.lessonsPerWeek` (default 2) +
  `preferredRoomId` (DB FK to room, no Prisma relation); new tenant table
  `teacher_unavailability` (migration `20260912000000_timetable_csp`, RLS
  `77_timetable_csp_rls.sql`, entrypoint-registered, RLS-e2e + coverage gate).
- **API**: POST /timetable/generate returns `TimetableGenerateResultDto`
  (placed/complete/unplaced-with-reason/diagnostics, names resolved);
  GET/PUT /timetable/availability (staff-wide; teachers list own only);
  offering quota/room set via POST /classes/:id/subjects (omitted fields never
  reset stored values). `lessonsPerSubject` on generate = legacy bulk override.
- **Web**: /timetable → TeacherAvailabilityEditor (day×period grid, teacher list
  from /users?kind=teacher — class.write accompanies timetable.write on all 3
  writing roles) + AutoGeneratePanel (replace toggle, diagnostics/unplaced
  panel); /classes offering form gained Lessons/wk + fixed-room.
- **Verified**: new `timetable.service.e2e-spec.ts` (real PG: grid clash-free BY
  QUERY, quotas/rooms/availability honored, name-resolved diagnostics,
  cross-tenant RLS, 403s). Full API 95 suites/749 tests, RLS 152, tsc 13/13,
  web build green. Test DB recipe per [cbt-governance](cbt-governance.md) (sms-test-pg :5434,
  major_user pw reset to 'majorpw', migration applied by psql -f).

Also confirmed this session: NO cross-school parent identity exists — `user`
rows are tenant-scoped with a GLOBALLY unique email, so a parent with children
in two platform schools needs two accounts under different emails. See
[scaling-5000-schools-program](scaling-5000-schools-program.md) (sharding discussion) for why identity stays
per-tenant.
