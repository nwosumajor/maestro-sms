-- A delivery row could not say whether a worker had ever handed it to a gateway.
-- Without that, a PENDING row is ambiguous between "never picked up" (safe to
-- send) and "sent, outcome lost" (sending again duplicates the message and
-- spends a second credit), and only the first kind can be recovered.
ALTER TABLE "notification_delivery" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "notification_delivery" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);

-- Existing SENT/FAILED rows were plainly attempted; existing PENDING rows are
-- the ambiguous ones and are deliberately left at 0 so the sweep treats them as
-- never-attempted. They predate any worker that could have stamped them, and
-- the alternative — assuming they were sent — abandons every one of them.
UPDATE "notification_delivery"
   SET "attempts" = 1, "lastAttemptAt" = COALESCE("sentAt", "updatedAt")
 WHERE "status" <> 'PENDING' AND "attempts" = 0;

-- The recovery sweep reads PENDING across EVERY tenant, oldest first, so it
-- cannot lead with schoolId like this table's other indexes.
CREATE INDEX IF NOT EXISTS "notification_delivery_status_createdAt_idx"
  ON "notification_delivery" ("status", "createdAt");
