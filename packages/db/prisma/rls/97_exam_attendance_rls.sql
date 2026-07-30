-- =============================================================================
-- 97: exam_attendance — who actually sat each exam. APPEND-ONLY.
-- =============================================================================
-- Tenant-scoped like every other exam table (rls/87). The posture is INSERT +
-- SELECT only, no UPDATE and no DELETE, mirroring integrity_signal and
-- disciplinary_entry.
--
-- WHY append-only: an exam absence has consequences — a resit, a withheld grade, a
-- malpractice enquiry — so the record of who marked what, and when, must not be
-- rewritable afterwards. A correction is a NEW row, and the latest row per
-- (sitting, student) is the current answer. That way a mark that was changed still
-- shows that it was changed, and by whom.
--
-- This is NOT the daily class register (attendance_session / attendance_record,
-- rls/04): that records whether a pupil was in SCHOOL on a day and stays fully
-- correctable within its 7-day window. A pupil can be in school and miss one exam;
-- the two tables answer different questions and deliberately have different rules.
--
-- Sentinel: exam_attendance_insert.
-- =============================================================================

ALTER TABLE "exam_attendance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exam_attendance" FORCE  ROW LEVEL SECURITY;

CREATE POLICY exam_attendance_select ON "exam_attendance" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY exam_attendance_insert ON "exam_attendance" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT           ON "exam_attendance" TO major_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "exam_attendance" FROM major_user;
