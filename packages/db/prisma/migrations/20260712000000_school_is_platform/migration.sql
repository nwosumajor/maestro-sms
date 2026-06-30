-- Platform-owner organization flag. TRUE only for the single "SMS Platform" org
-- that hosts super_admin(s); excluded from customer surfaces + billing. The
-- `school` table is the global, RLS-exempt registry, so no RLS policy change.
ALTER TABLE "school" ADD COLUMN "isPlatform" BOOLEAN NOT NULL DEFAULT false;
