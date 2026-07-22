# LMS module

> LMS core module (Classes/Enrollment/Guardians + relationship scoping) — built and verified

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

First product module after the foundation: LMS core (keystone for relationship-scoping RBAC). Built + verified end-to-end against real Postgres.

- **Models** (`packages/db/prisma/schema/lms.prisma`, all tenant-scoped + RLS): `Class`, `ClassTeacher` (teaching assignments), `Enrollment` (students), `ParentChild` (guardian links). Added `Assessment.classId` (links integrity assessments to a class). Back-relations added to School/User in foundation.prisma.
- **RLS**: `packages/db/prisma/migrations/20260618_lms_rls/migration.sql` (DO-loop enabling fail-closed RLS + grants on class/class_teacher/enrollment/parent_child).
- **Permissions** (`packages/types/src/permissions/lms.ts`, exported from barrel): class.read/write, enrollment.read/write, guardian.write + LMS_ROLE_PERMISSIONS.
- **API** (`apps/api/src/lms/`): LmsModule/Service/Controller. Endpoints: POST /classes, POST /classes/:id/teachers, POST /classes/:id/enrollments, POST /guardians, GET /classes/mine (relationship-scoped), GET /classes/:id (roster, teacher-of-class or admin only). Mutations audit-logged.
- **Relationship scoping** (the security heart, in LmsService.listMyClasses): teacher→class_teacher, student→enrollment, parent→parent_child→enrollment, school_admin/super_admin→all. Not-visible → 404 not 403.
- **Seed** (`packages/db/prisma/seed.ts`): users teacher/student/parent/admin@demo.school (pw password123), class "History 101" (id 5555...), teacher assigned, student enrolled, parent linked, assessment 3333 linked to the class. Roles: teacher/student/parent/school_admin.

VERIFIED: teacher/student/parent each see ONLY History 101 via /classes/mine; non-member teacher sees (none) + roster 404; cross-tenant roster 404; admin sees all + creates class (201) with durable lms.class.create audit. Typecheck 8/8.

Demo logins (sms_verify db, pw `password123`): teacher@ / student@ / parent@ / admin@demo.school.

NEXT candidate product modules (CLAUDE.md deferred): gradebook, attendance, timetabling, fees/billing, approval engine (Temporal/Camunda — stub interface), notifications. Gradebook/attendance now unblocked (class+enrollment exist). No LMS UI screen built yet (API only).
