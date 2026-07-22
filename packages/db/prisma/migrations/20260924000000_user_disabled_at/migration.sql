-- Revocation timestamp for account status changes (operator staff console).
ALTER TABLE "user" ADD COLUMN "disabledAt" TIMESTAMP(3);
