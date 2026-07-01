-- Password policy + permanent lockout.
-- locked: set on the 3rd failed login; cleared only by a super_admin.
-- passwordChangedAt: 30-day reset clock for non-super_admin accounts. DEFAULT now()
-- backfills existing rows to a fresh window; a null value = must change immediately.
ALTER TABLE "user" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN "passwordChangedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
