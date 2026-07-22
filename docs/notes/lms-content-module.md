# LMS content module

> LMS learning-content module (materials/lessons/quizzes/forums, approval-gated) build status

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

LMS **learning content** module — distinct from the LMS core ([lms-module](lms-module.md)
classes/enrollment/guardians). Approval-gated content: DRAFT → PENDING_APPROVAL →
(principal review via the workflow engine) → PUBLISHED | REJECTED |
REVISION_REQUESTED. Only PUBLISHED reaches enrolled students; quiz answer keys
stripped server-side.

- **Backend committed** in `dc868d3` ("lms update"): tables `lms_content` /
  `quiz_attempt` / `forum_post` (`schema/lms_content.prisma`), RLS `23_lms_content_rls.sql`,
  migration `20260630000000_lms_content`, `lms-content.{service,controller,util}.ts`,
  DTOs `packages/types/src/dto/lms-content.ts`, perms CONTENT_READ/WRITE/APPROVE +
  QUIZ_ATTEMPT/FORUM_POST, workflow type `LMS_CONTENT_PUBLISH`. PDFs reuse the
  Document Vault StorageProvider (presigned). Author = teacher-of-class/school_admin;
  approver = principal (separation of duties).
- **Web UI** (`20be32c`): added route `GET /content/approvals/pending` + full UI —
  `app/(app)/classes/[id]/content` (ContentManager), `app/(app)/content/[id]`
  (ContentDetail: lesson HTML / material download / quiz-take / forum),
  `app/(app)/content/approvals` (ApprovalQueue). Reached through the Classes page.
- **Publish-notify + quiz result** (`3cf758f`, committed 2026-06-26): on review→
  PUBLISHED, `notifyPublished` alerts enrolled students + linked guardians
  (audience resolved in-tx via `contentAudience`, enqueue post-commit best-effort;
  `NotificationModule` now imported by `lms.module.ts`). New `GET /content/:id/quiz/me`
  (`myQuizResult`) re-grades the student's own attempt server-side (recovers
  `correct[]`, never leaks the key); web QuizView shows a read-only prior result.

**Module is COMPLETE** against the full checklist: RLS `23_lms_content_rls.sql`
(registered in docker-entrypoint under `forum_post_update`), migration, cross-tenant
RLS e2e cases for all 3 tables, service+util tests, seeded perms, web UI. api+web
typecheck clean, util tests green. DB e2e needs TEST_DATABASE_URL (sandbox has none).
**Why:** every built module gets a role-filtered web UI per CLAUDE.md.
