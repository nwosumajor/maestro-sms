-- A seat, a roster place and a schedule belong to a real person.
--
-- `exam_attendance` — the register — already FKs BOTH of its person columns to
-- `user`. The four sibling columns in the same module had none, and the gap was
-- not theoretical: `ExamService.seat` validated nothing about the ids it was
-- given, so a uuid belonging to nobody could take seat #1 with a blank name
-- (measured live, HTTP 201).
--
-- The application-level check is the one that produces a usable sentence, and it
-- now refuses. This is the declarative half, which this repo prefers wherever the
-- rule can be expressed as one: it binds every writer for ever, including a
-- manual fix at 2am, and costs nothing at read time.
--
-- It also closes a failure the app check cannot reach retroactively. A phantom
-- seat is STORABLE but UNMARKABLE, because the register's own studentId IS
-- FK'd — and an invigilator submits the whole hall as one insert, so one bad id
-- failed the entire register with an untranslated P2003 (HTTP 500) on exam
-- morning.
--
-- ON DELETE RESTRICT, matching `exam_attendance` exactly. Users are never hard
-- deleted here (an exit sets a status and keeps the record), so this forbids
-- nothing the product does.
--
-- Verified before writing: zero orphan ids in any of the four columns.

ALTER TABLE "exam_seat"
  ADD CONSTRAINT "exam_seat_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "exam_invigilator"
  ADD CONSTRAINT "exam_invigilator_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "exam_sitting"
  ADD CONSTRAINT "exam_sitting_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "exam_schedule"
  ADD CONSTRAINT "exam_schedule_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
