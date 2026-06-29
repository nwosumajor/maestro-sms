-- Human-readable GLOBAL unique identifier for every person (student + staff) for
-- ID cards, audit, and cross-school search. A DB DEFAULT generates one on EVERY
-- insert (so all creation paths get one with no app code). Existing rows are
-- backfilled deterministically from their id (collision-free). No new table.

-- 1) Add nullable, backfill existing rows uniquely from their id (md5 of the uuid).
ALTER TABLE "user" ADD COLUMN "uniqueId" TEXT;
UPDATE "user" SET "uniqueId" = 'SMS-' || upper(substr(md5(id::text), 1, 12));

-- 2) Enforce NOT NULL + the generation default for future inserts.
ALTER TABLE "user" ALTER COLUMN "uniqueId" SET NOT NULL;
ALTER TABLE "user" ALTER COLUMN "uniqueId"
  SET DEFAULT ('SMS-' || upper(substr(md5((random())::text || (clock_timestamp())::text), 1, 12)));

-- 3) Globally unique.
CREATE UNIQUE INDEX "user_uniqueId_key" ON "user"("uniqueId");
