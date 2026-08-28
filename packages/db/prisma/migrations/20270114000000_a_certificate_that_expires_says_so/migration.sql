-- A certificate that has EXPIRED says so.
--
-- The staff-document sweep announced a document once, up to 30 days before it
-- expired, stamped `reminderSentAt` and never looked again — so the day a
-- teaching licence or safeguarding check actually lapsed produced silence.
-- `expiryNoticeStage` records which notice has gone, and one is sent only when
-- it CHANGES, so a document is announced at most twice.
ALTER TABLE "staff_document" ADD COLUMN "expiryNoticeStage" TEXT;

-- BACKFILL: a row that has already been notified received the "expiring soon"
-- notice, whatever its date now is, so that is the stage it is at.
--
-- This is the deliberate choice, and it has a visible consequence: the first
-- sweep after this migration sends an EXPIRED notice for every document a
-- school has already let lapse. That is a one-time burst, and every notice in
-- it is TRUE and currently unreported — which is the whole defect. Stamping
-- those rows terminal instead would suppress the burst by permanently
-- concealing the lapses, and a school cannot act on what it is not told.
UPDATE "staff_document" SET "expiryNoticeStage" = 'EXPIRING' WHERE "reminderSentAt" IS NOT NULL;

-- The sweep reads by stage over the whole fleet on the privileged client, so
-- the rows that can still change stage are the ones worth indexing.
CREATE INDEX "staff_document_expiry_notice_idx"
  ON "staff_document" ("expiresAt")
  WHERE "expiresAt" IS NOT NULL AND ("expiryNoticeStage" IS NULL OR "expiryNoticeStage" <> 'EXPIRED');

-- THE SIBLING, in the same file and one method down. A contract was announced
-- once before it ended, `contractReminderSentAt` was stamped, and the day it
-- actually ended produced silence — while the employee stayed ACTIVE. Somebody
-- working past the end of their contract is a fact a school has to act on.
ALTER TABLE "employee" ADD COLUMN "contractNoticeStage" TEXT;
UPDATE "employee" SET "contractNoticeStage" = 'EXPIRING' WHERE "contractReminderSentAt" IS NOT NULL;
