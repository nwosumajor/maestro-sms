-- The platform paying a school the fee money it collected on its behalf.
--
-- A payment made before the school registered a settlement bank lands in the
-- PLATFORM's gateway account. The invoice is correctly PAID and the cash is the
-- platform's to hand over; that debt was shown on the school's fees page and
-- dischargeable only by email, so the balance could never go down and nothing
-- recorded that a transfer had happened.
CREATE TABLE IF NOT EXISTS "platform_settlement_release" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "schoolId"     UUID         NOT NULL,
  "amountMinor"  INTEGER      NOT NULL,
  "currency"     TEXT         NOT NULL,
  "paymentCount" INTEGER      NOT NULL,
  "reference"    TEXT         NOT NULL,
  "note"         TEXT,
  "releasedById" UUID         NOT NULL,
  "releasedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_settlement_release_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "platform_settlement_release_schoolId_idx"
  ON "platform_settlement_release" ("schoolId");
CREATE INDEX IF NOT EXISTS "platform_settlement_release_schoolId_releasedAt_idx"
  ON "platform_settlement_release" ("schoolId", "releasedAt");

ALTER TABLE "platform_settlement_release"
  ADD CONSTRAINT "platform_settlement_release_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Which release discharged a held payment. NULL means the money is still owed,
-- which is what lets the held balance be a SUM over unreleased rows rather than
-- a number somebody maintains by hand.
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "platformReleaseId" UUID;

ALTER TABLE "payment"
  ADD CONSTRAINT "payment_platformReleaseId_fkey"
  FOREIGN KEY ("platformReleaseId") REFERENCES "platform_settlement_release"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The held-balance query: unreleased platform-settled payments for one school.
CREATE INDEX IF NOT EXISTS "payment_schoolId_settledToPlatform_platformReleaseId_idx"
  ON "payment" ("schoolId", "settledToPlatform", "platformReleaseId");
