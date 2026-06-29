-- Platform-owner 2FA mandate. `mfa_required` lets a super_admin force a user (or
-- a whole role, set in bulk from the operator console) to enrol TOTP MFA before
-- they can log in. Distinct from `mfa_enabled` (the user's own enrolment state):
-- AuthService blocks login when mfa_required AND NOT mfa_enabled. No new table →
-- User is already tenant-scoped + RLS-covered, so no RLS file change.

ALTER TABLE "user" ADD COLUMN "mfaRequired" BOOLEAN NOT NULL DEFAULT false;
