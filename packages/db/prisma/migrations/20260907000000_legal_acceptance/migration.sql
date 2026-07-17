-- Clickwrap: append-only legal-acceptance ledger (RLS in rls/76) + the version
-- accepted on the public onboarding form.

CREATE TABLE "legal_acceptance" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "docVersion" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legal_acceptance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "legal_acceptance_schoolId_docVersion_idx" ON "legal_acceptance"("schoolId", "docVersion");
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "onboarding_request" ADD COLUMN "legalVersion" TEXT;
