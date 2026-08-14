-- Cross-school consent records WHOSE consent it is.
--
-- `ultimate_consent` recorded only `grantedById` — the school_admin who ticked
-- the box — while the column, the UI label and the spec all called it GUARDIAN
-- consent. No guardian appeared anywhere in the row, so a school could assert a
-- parent's decision about their child with nothing behind it, on the one surface
-- where a minor's handle and school name cross a tenant boundary.
--
-- NULLABLE on purpose: rows written before this change genuinely have no
-- guardian recorded, and inventing one would be worse than admitting it. The
-- service refuses to GRANT without one from now on; existing grants stand and
-- read as what they are.
ALTER TABLE "ultimate_consent" ADD COLUMN IF NOT EXISTS "guardianId" UUID;

-- The guardian must be a real user in the same school. RESTRICT, like every
-- other tenant FK here: a consent record must not outlive the person who gave it
-- without somebody noticing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ultimate_consent_guardianId_fkey'
  ) THEN
    ALTER TABLE "ultimate_consent"
      ADD CONSTRAINT "ultimate_consent_guardianId_fkey"
      FOREIGN KEY ("guardianId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
