-- =============================================================================
-- report_card_attestation — RLS
-- =============================================================================
-- Tenant-scoped like every other academic record. The PUBLIC verification route
-- reads through here too: it resolves the school from the RLS-exempt registry by
-- slug FIRST, then runs the lookup under this policy with that school's GUC set.
-- So an unauthenticated verifier is confined by the same policy as a member of
-- staff, and a code from another school simply does not exist to the query.
--
-- NO DELETE for the app role. An attestation is what somebody was told a
-- document said; removing one silently turns every card carrying its code into
-- an unverifiable page. Superseding is an UPDATE that bumps `version`.
ALTER TABLE "report_card_attestation" ENABLE ROW LEVEL SECURITY;
-- FORCE matters as much as ENABLE: without it the table OWNER bypasses every
-- policy above, and migrations and seeds run as exactly that owner.
ALTER TABLE "report_card_attestation" FORCE  ROW LEVEL SECURITY;

CREATE POLICY report_card_attestation_select ON "report_card_attestation"
  FOR SELECT USING ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY report_card_attestation_insert ON "report_card_attestation"
  FOR INSERT WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

CREATE POLICY report_card_attestation_update ON "report_card_attestation"
  FOR UPDATE USING ("schoolId" = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK ("schoolId" = current_setting('app.current_school_id', true)::uuid);

GRANT  SELECT, INSERT, UPDATE ON "report_card_attestation" TO major_user;
-- No DELETE and no TRUNCATE for the app role: an attestation is what somebody
-- was told a document said, and removing one turns every card carrying its code
-- into an unverifiable page.
REVOKE DELETE, TRUNCATE       ON "report_card_attestation" FROM major_user;

-- Sentinel: report_card_attestation_update.
