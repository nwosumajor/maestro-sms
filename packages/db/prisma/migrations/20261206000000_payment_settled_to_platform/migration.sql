-- Records whether an online charge settled into the PLATFORM's gateway account
-- instead of the school's own bank (no settlement subaccount at the time).
--
-- A snapshot, not a derivation: computed from current state, the day a school
-- registers its bank every historical payment would silently stop being owed.
--
-- Existing rows default to FALSE. That is deliberate and is the honest option:
-- this column records a debt the platform KNOWS it incurred, and back-filling a
-- guess across history would either invent debts or, worse, assert that money
-- already released is still held. Where a school has never had a subaccount its
-- pre-migration collections are reconciled by hand against the gateway.
ALTER TABLE "payment" ADD COLUMN "settledToPlatform" BOOLEAN NOT NULL DEFAULT false;

-- The held-funds figure is "unreleased platform-settled payments for a school".
-- Partial, because the true rows are a small minority and only they are ever
-- scanned — the index stays tiny however large the payment table grows.
CREATE INDEX "payment_settledToPlatform_idx"
  ON "payment" ("schoolId")
  WHERE "settledToPlatform" = true;
