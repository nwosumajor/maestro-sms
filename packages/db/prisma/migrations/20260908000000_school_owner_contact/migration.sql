-- School owner/proprietor contact + address (global registry columns; app role
-- SELECT-only — writes flow through the privileged provisioning/operator client).
ALTER TABLE "school" ADD COLUMN "ownerName" TEXT;
ALTER TABLE "school" ADD COLUMN "ownerPhone" TEXT;
ALTER TABLE "school" ADD COLUMN "address" TEXT;

-- Onboarding intake now records the proprietor distinctly from the day-to-day contact.
ALTER TABLE "onboarding_request" ADD COLUMN "ownerName" TEXT;
ALTER TABLE "onboarding_request" ADD COLUMN "ownerPhone" TEXT;
