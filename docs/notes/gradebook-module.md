# Gradebook module

> Gradebook module (manual grading + read scoping) — built and verified

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Second product module: Gradebook. Built + verified end-to-end, with tracked migration + RLS + committed tests.

- **Model** (`packages/db/prisma/schema/gradebook.prisma`): `Grade` (tenant-scoped, RLS): submissionId @unique, score, maxScore, feedback?, status (DRAFT|PUBLISHED), gradedById, gradedAt, updatedAt. Back-relations: Submission.grade?, User.gradesGiven, School.grades. // GR#8: a Grade is ALWAYS a manual teacher decision — never auto-derived from integrity signals; no code path writes a Grade from a detector.
- **Tracked migration**: `prisma migrate dev --name gradebook` → `packages/db/prisma/migrations/20260619105301_gradebook`. RLS in `packages/db/prisma/rls/04_gradebook_rls.sql`.
- **Permissions** (`packages/types/src/permissions/gradebook.ts`, barrel-exported): grade.read, grade.write + GRADEBOOK_ROLE_PERMISSIONS.
- **API** (`apps/api/src/gradebook/`): POST /submissions/:id/grade (grade.write), GET /submissions/:id/grade (grade.read, scoped), GET /grades/mine (grade.read). Wired into AppModule.
- **Scoping** (GradebookService): grade.write only if teacher-of-the-assessment's-class OR assessment author OR school_admin (else 404). grade read: teachers/admin see any status; student sees OWN+PUBLISHED only; parent sees CHILD'S+PUBLISHED only. listMyGrades = published grades for self + children. score validated 0..maxScore. Writes audit-logged (gradebook.grade.set).
- **Tests**: `apps/api/test/gradebook/gradebook.service.spec.ts` (scoping + validation) + grade added to `rls.e2e-spec.ts` cross-tenant cases. Totals now: api 40 tests (6 suites), web 4. Typecheck 8/8.

VERIFIED live: teacher-of-class grades PUBLISHED → 201; student sees own published grade + /grades/mine; parent sees child's grade; cross-tenant teacher → 404; durable gradebook.grade.set audit. seed gives all four demo users grade perms.

NEXT product modules (CLAUDE.md deferred, remaining): attendance, timetabling, fees/billing, approval engine (Temporal/Camunda), notifications. Still no UI for foundation/LMS/gradebook (API only). Production infra still pending (Dockerfiles/Terraform/secrets/retention).
