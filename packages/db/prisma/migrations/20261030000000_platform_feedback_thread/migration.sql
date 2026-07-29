-- Two-way feedback thread: append-only messages + a lastActivityAt sort key.

-- lastActivityAt on the parent (backfilled to createdAt so existing rows sort sanely).
ALTER TABLE "platform_feedback" ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "platform_feedback" SET "lastActivityAt" = "createdAt";

CREATE INDEX "platform_feedback_lastActivityAt_id_idx" ON "platform_feedback"("lastActivityAt", "id");
CREATE INDEX "platform_feedback_status_lastActivityAt_id_idx" ON "platform_feedback"("status", "lastActivityAt", "id");

-- The append-only conversation table.
CREATE TABLE "platform_feedback_message" (
  "id"         UUID NOT NULL,
  "schoolId"   UUID NOT NULL,
  "feedbackId" UUID NOT NULL,
  "authorId"   UUID NOT NULL,
  "authorSide" TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_feedback_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_feedback_message_schoolId_idx" ON "platform_feedback_message"("schoolId");
CREATE INDEX "platform_feedback_message_feedbackId_createdAt_idx" ON "platform_feedback_message"("feedbackId", "createdAt");
-- Hot counts that would otherwise SEQ SCAN this append-only table as it grows:
-- the per-author rolling-hour reply cap, and the digest's SENDER-reply window.
CREATE INDEX "platform_feedback_message_authorId_createdAt_idx" ON "platform_feedback_message"("authorId", "createdAt");
CREATE INDEX "platform_feedback_message_authorSide_createdAt_idx" ON "platform_feedback_message"("authorSide", "createdAt");

ALTER TABLE "platform_feedback_message"
  ADD CONSTRAINT "platform_feedback_message_feedbackId_fkey"
  FOREIGN KEY ("feedbackId") REFERENCES "platform_feedback"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
