-- A boarder who is late back is the thing an exeat register exists to notice.
--
-- The register recorded who was out, when they were due, and told the guardians
-- at approval time. Then nothing ever read `expectedReturnAt` again — no sweep,
-- no flag, no alert. A child due back at six who does not arrive produced no
-- signal at all; the school found out when somebody happened to look.
--
-- This column makes the alert fire ONCE rather than every hour until someone
-- acts, and is cleared on return so a second late return alerts again.
ALTER TABLE "hostel_exeat" ADD COLUMN IF NOT EXISTS "overdueNotifiedAt" TIMESTAMP(3);

-- The sweep asks "who is still out and past due", across every school, every
-- hour. Without this it is a full scan of every exeat a school has ever issued.
CREATE INDEX IF NOT EXISTS "hostel_exeat_overdue_idx"
    ON "hostel_exeat" ("status", "expectedReturnAt")
 WHERE "actualReturnAt" IS NULL;
