-- The last two code-only "one per" rules found by the check-then-act sweep.
--
-- 1. ONE SITTING PER CBT EXAM. `createSitting` reads
--    `examSitting.findFirst({ where: { cbtExamId } })` and refuses with "That CBT
--    exam is already attached to a sitting", then inserts. Two requests together
--    both read nothing and both attach: the same paper is sat in two halls, and
--    the marks come back against two sittings.
--
--    Partial, because `cbtExamId` is nullable and most sittings are paper: a
--    plain unique index would allow only ONE sitting with no CBT exam in the
--    entire school.
--
-- 2. ONE OPEN MEETING REQUEST per (parent, child, teacher). The guard exists so
--    "a parent waiting on a slow reply re-asks, and the teacher's inbox fills
--    with the same conversation" — its own words. Lower stakes than the others
--    in this sweep and closed for the same reason: a rule worth stating in code
--    is worth stating where two requests cannot both slip past it.
--
-- Both checked for existing violations before being added: none on this
-- database. A failure elsewhere has FOUND duplicates rather than caused them.
CREATE UNIQUE INDEX IF NOT EXISTS "exam_sitting_one_per_cbt_exam"
  ON "exam_sitting" ("cbtExamId") WHERE "cbtExamId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "meeting_request_one_open_per_trio"
  ON "meeting_request" ("parentId", "studentId", "teacherId")
  WHERE status IN ('PENDING_APPROVAL', 'PENDING_TEACHER');
