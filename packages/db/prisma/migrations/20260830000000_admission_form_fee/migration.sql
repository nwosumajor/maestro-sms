-- Admission-form fees: per-school fee on the global registry, snapshot +
-- payment state on each application. Collected on the school's settlement
-- split with the platform take-rate — the same rails as fee collection.

ALTER TABLE "school" ADD COLUMN "admissionFormFeeMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "admission_application" ADD COLUMN "formFeeMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "admission_application" ADD COLUMN "formFeePaidAt" TIMESTAMP(3);
ALTER TABLE "admission_application" ADD COLUMN "formFeeRef" TEXT;
