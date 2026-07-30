-- =============================================================================
-- exam_attendance — the append-only per-sitting register
-- =============================================================================
-- Closes a real dead end: the printable attendance sheet had an "Absent" column
-- that an invigilator filled in on paper and that never re-entered the system, so
-- nothing could answer "who missed the Mathematics exam?".
--
-- Deliberately NOT the daily class register (attendance_session /
-- attendance_record). That records whether a pupil was in SCHOOL on a day; a pupil
-- can be in school and still miss one exam, so folding exam absence into the day's
-- register would overwrite the class teacher's mark with something it does not
-- mean. Two facts, two tables, two sets of rules.
--
-- APPEND-ONLY: no UPDATE or DELETE grant (see prisma/rls/97_exam_attendance_rls.sql).
-- An exam absence has consequences — a resit, a withheld grade, a malpractice
-- enquiry — so a correction is a NEW row and the latest row per (sitting, student)
-- wins. A changed mark still shows that it changed, and who changed it.
--
-- Guarded throughout so re-running is a no-op: a migration that fails blocks every
-- later one and takes the API down on boot (PR #21).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "exam_attendance" (
    "id"         UUID NOT NULL,
    "schoolId"   UUID NOT NULL,
    "sittingId"  UUID NOT NULL,
    "studentId"  UUID NOT NULL,
    -- PRESENT | ABSENT. A plain TEXT column, not the four-value AttendanceStatus
    -- enum of the daily register: an invigilator knows only who is in the seat.
    -- "Excused"/"late" are later judgements, and offering them here would imply the
    -- invigilator made them.
    "status"     TEXT NOT NULL,
    "note"       TEXT,
    "markedById" UUID NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_attendance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "exam_attendance_schoolId_idx"
  ON "exam_attendance"("schoolId");
-- Serves the hot read: the LATEST row per student within one sitting.
CREATE INDEX IF NOT EXISTS "exam_attendance_schoolId_sittingId_studentId_createdAt_idx"
  ON "exam_attendance"("schoolId", "sittingId", "studentId", "createdAt");
-- Serves "which exams has this pupil missed?".
CREATE INDEX IF NOT EXISTS "exam_attendance_schoolId_studentId_idx"
  ON "exam_attendance"("schoolId", "studentId");

DO $$
BEGIN
  -- RESTRICT to school (Golden Rule #1, the convention all 176 tenant tables now
  -- share); CASCADE from the sitting, since attendance for a deleted sitting is
  -- meaningless on its own.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exam_attendance_schoolId_fkey') THEN
    ALTER TABLE "exam_attendance" ADD CONSTRAINT "exam_attendance_schoolId_fkey"
      FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exam_attendance_sittingId_fkey') THEN
    ALTER TABLE "exam_attendance" ADD CONSTRAINT "exam_attendance_sittingId_fkey"
      FOREIGN KEY ("sittingId") REFERENCES "exam_sitting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- studentId / markedById follow the documented "scalar column + DB FK, no Prisma
  -- relation" pattern that keeps the User model lean.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exam_attendance_studentId_fkey') THEN
    ALTER TABLE "exam_attendance" ADD CONSTRAINT "exam_attendance_studentId_fkey"
      FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exam_attendance_markedById_fkey') THEN
    ALTER TABLE "exam_attendance" ADD CONSTRAINT "exam_attendance_markedById_fkey"
      FOREIGN KEY ("markedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
