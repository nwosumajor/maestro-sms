-- Maker-checker on payments: status + kind + approver. Existing rows are POSTED
-- PAYMENTs (the defaults), so balances are unchanged. RLS already covers payment.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'PENDING_APPROVAL', 'REJECTED');
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'REFUND');

-- AlterTable
ALTER TABLE "payment" ADD COLUMN "kind" "PaymentKind" NOT NULL DEFAULT 'PAYMENT';
ALTER TABLE "payment" ADD COLUMN "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED';
ALTER TABLE "payment" ADD COLUMN "approvedById" UUID;

-- AddForeignKey (approver — DB FK only, no Prisma relation)
ALTER TABLE "payment" ADD CONSTRAINT "payment_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Index pending payments for the approver queue.
CREATE INDEX "payment_schoolId_status_idx" ON "payment"("schoolId", "status");
