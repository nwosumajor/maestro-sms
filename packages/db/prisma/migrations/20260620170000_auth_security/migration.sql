-- Auth hardening: TOTP MFA secret/flag + brute-force lockout counters on user.
-- No new RLS — the user table is already RLS-enforced (02_foundation_rls.sql).

ALTER TABLE "user" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "user" ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user" ADD COLUMN "lockedUntil" TIMESTAMP(3);
