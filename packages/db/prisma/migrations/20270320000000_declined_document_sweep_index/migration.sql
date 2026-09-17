-- The declined-applicant retention sweep asks, across every tenant: "which
-- supplied files are still held for an application the school turned down?"
--
-- It used to ask that one application at a time, filtering `document_submission`
-- on ("subjectKind", "subjectId") with no "schoolId" — and every index on that
-- table is tenant-leading, so none could serve it and each of the 500 lookups
-- in a run scanned the whole table.
--
-- Partial on both halves of the predicate, because the candidate set is tiny
-- next to the table: a file is only a candidate while it is still HELD, and it
-- drops out of the index the moment the sweep clears it. The subjectKind
-- literal is a constant in the query, so the planner can prove the predicate.
CREATE INDEX IF NOT EXISTS "document_submission_admission_files_held_idx"
  ON "document_submission" ("subjectId")
  WHERE "subjectKind" = 'ADMISSION_APPLICATION' AND "storageKey" IS NOT NULL;

-- The other side of that join: the sweep is interested only in applications a
-- school DECLINED, and looks at them by age. Every other index on this table
-- leads with "schoolId", which serves each school's own admissions screens and
-- can serve no fleet sweep at all.
CREATE INDEX IF NOT EXISTS "admission_application_status_updatedAt_idx"
  ON "admission_application" (status, "updatedAt");
