-- Self-service personal/bank fields on employee (field-encrypted at rest)
ALTER TABLE "employee" ADD COLUMN     "addressEnc" TEXT,
ADD COLUMN     "bankAccountEnc" TEXT,
ADD COLUMN     "bankNameEnc" TEXT,
ADD COLUMN     "nextOfKinEnc" TEXT,
ADD COLUMN     "nextOfKinPhoneEnc" TEXT,
ADD COLUMN     "phoneEnc" TEXT;

-- Fractional leave (0.5 = half day)
ALTER TABLE "leave_balance" ALTER COLUMN "entitledDays" SET DEFAULT 0,
ALTER COLUMN "entitledDays" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "usedDays" SET DEFAULT 0,
ALTER COLUMN "usedDays" SET DATA TYPE DOUBLE PRECISION;

ALTER TABLE "leave_request" ALTER COLUMN "days" SET DATA TYPE DOUBLE PRECISION;
