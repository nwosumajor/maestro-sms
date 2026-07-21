-- Per-school "require MFA for all staff" policy.
ALTER TABLE "school" ADD COLUMN "requireStaffMfa" BOOLEAN NOT NULL DEFAULT false;
