-- Paystack dedicated-NUBAN virtual accounts: one per student; bank transfers
-- to it auto-credit the student's oldest open invoice via the webhook.

CREATE TABLE "student_virtual_account" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "customerCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_virtual_account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_virtual_account_customerCode_key" ON "student_virtual_account"("customerCode");
CREATE UNIQUE INDEX "student_virtual_account_schoolId_studentId_key" ON "student_virtual_account"("schoolId", "studentId");
CREATE INDEX "student_virtual_account_schoolId_idx" ON "student_virtual_account"("schoolId");

ALTER TABLE "student_virtual_account"
  ADD CONSTRAINT "student_virtual_account_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
