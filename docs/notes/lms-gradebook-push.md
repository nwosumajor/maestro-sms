# LMS gradebook push

> LMS→report-card grade push feature (tag content, aggregate, pull into SubjectResult CA slice); built + live-verified, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The final LMS-program feature "#5 Gradebook push" — built 2026-07-11, live-verified end-to-end, **UNCOMMITTED**. Design decisions (chosen by the user via AskUserQuestion): (1) **teachers PULL** aggregated LMS scores into the report card (not auto-sync); (2) content is **tagged** with a (subject, term).

Shape:
- `lms_content` gained nullable `subjectId`/`termId` (migration `20260810000000_lms_content_grade_tag`, applied to live DB via `docker exec sms-postgres-1 psql`). No new table ⇒ no new RLS file. Only QUIZ/ASSIGNMENT are taggable, and only while DRAFT/REVISION_REQUESTED (updateContent guard).
- `LmsContentService.lmsGradebook()` aggregates each roster student's earned/possible across tagged, PUBLISHED quizzes (best/latest per quiz's scoring) + graded assignments → percent. `applyLmsGrades()` scales percent → the 10-pt `assignment` CA slice (`scaleToComponent` in lms-content.util) and writes via a NEW **merge-aware** `TermResultService.applyAssignmentComponent()`.
- CRITICAL gotcha handled: `TermResultService.applyComponents` OVERWRITES all four components, so the LMS apply MERGES (reads existing exam/midterm/classNote, keeps them) — verified: exam=50/midterm=15 preserved while assignment set to 9. Writes DRAFT + honors the PENDING_APPROVAL maker-checker guard; teacher then publishes via the normal head-teacher→principal chain (Golden Rule #8: no auto-final).
- Endpoints (gated `grade.write`): `GET /classes/:id/lms-grades?subjectId=&termId=`, `POST /classes/:id/lms-grades/apply`. Web: `LmsGradebook.tsx` panel on the class content page (tag drafts + pull-into-report-card table), gated on grade.write.
- LmsModule now imports GradebookModule (one-way dep for TermResultService).

Verified live: teacher (subject-teacher scoped) tagged content persists + partial-tag→400; aggregation 7/8→88%→CA 9; apply writes DRAFT SubjectResult; merge preserves other components; 2 audit rows `gradebook.term.grade.lms_applied`. api tsc 0, web tsc 0, 14 util tests. See [july-2026-hardening-sweep](july-2026-hardening-sweep.md) for the host-run deploy recipe.
