-- =============================================================================
-- 107: student_trait_rating — behavioural / psychomotor ratings
-- =============================================================================
-- Tenant-scoped like every other record about a pupil. Full CRUD for the app
-- role: a rating is a CORRECTION-friendly judgement, not a ledger entry — a
-- teacher who mis-clicks 1 instead of 4 on a child's honesty must be able to put
-- it right, and the row carries `ratedById`/`ratedAt` so the correction is
-- attributable. DELETE is allowed for the same reason: a trait removed from the
-- school's catalogue leaves rows that should be clearable.
--
-- What protects the pupil is not immutability here but the audit log: every
-- write goes through the service, which records the actor (Golden Rule #8 — a
-- judgement about a child is a person's, never the system's).
--
-- Sentinel: student_trait_rating_delete.
-- =============================================================================

ALTER TABLE "student_trait_rating" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_trait_rating" FORCE  ROW LEVEL SECURITY;

CREATE POLICY student_trait_rating_select ON "student_trait_rating" FOR SELECT
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_trait_rating_insert ON "student_trait_rating" FOR INSERT
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_trait_rating_update ON "student_trait_rating" FOR UPDATE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);
CREATE POLICY student_trait_rating_delete ON "student_trait_rating" FOR DELETE
  USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE, DELETE ON "student_trait_rating" TO major_user;
REVOKE TRUNCATE                       ON "student_trait_rating" FROM major_user;
