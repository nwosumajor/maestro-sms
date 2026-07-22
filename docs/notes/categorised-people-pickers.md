# Categorised people pickers

> GET /users?kind=staff|teacher|parent + every picker categorised (no more mixed staff/student lists); supervisor picker was showing students — fixed; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

User-reported bug (2026-07-13): person pickers mixed staff and students — the
class-supervisor picker literally offered students (`ClassSubjectsAdmin`'s
`const staff = users` where `users` = the WHOLE school directory).

Fix, two layers:
- **API**: `GET /users?kind=staff|teacher|parent` (zod-validated; invalid → 400).
  `LmsService.listUsers` filters via a Prisma role-relation `where`; "staff" =
  any role NOT in `NON_STAFF_ROLE_NAMES` (["student","parent"] in the new
  `@sms/types/roles.ts`, alongside `USER_KINDS` + `userCategory()` for grouped
  UIs). Data-driven: a newly seeded staff role is automatically staff. No kind
  param = full directory (kept for /admin/roles).
- **Web**: supervisor picker = teachers only; classes page fetches
  kind=staff + kind=parent (ClassAdmin gets both, ClassSubjectsAdmin staff only);
  hostel warden / transport driver / HR pages fetch kind=staff (HR client-side
  role filters removed); TaskBoard = Staff/Students toggle tabs (picked set
  persists across categories, props changed people→staff+students);
  DisciplineRoom = Type (Student/Teacher) select FIRST drives the Against list,
  resolver list = staff; CertificateIssuer = For (Student/Staff) select then
  person; SendAnnouncement = optgroups Staff/Students/Parents via userCategory.

Verified live: /users 17, kind=staff 15 (no student/parent-only rows),
kind=teacher 1, bad kind 400; route smoke green (admin/principal/teacher/
hrmanager × 69 routes). Related: [branding-portal-logo](branding-portal-logo.md) session's dev recipe.
UNCOMMITTED like the rest of the backlog.
