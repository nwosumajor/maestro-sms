-- Message credits: tie a debit to a real send, and stop reading the whole
-- ledger to answer "what is the balance".
--
-- providerRef: the messaging provider's own id (Twilio's SID) for the message
-- a credit paid for. Without it there is nothing to reconcile against — the
-- platform is billed by the provider per message and charges the school per
-- credit, and until now nothing checked those two counts against each other.
--
-- balanceAfter: set ONLY on CHECKPOINT rows. Balance stays SUM(deltaCredits),
-- which is the right invariant (a stored counter drifts from its own history),
-- but that sum ran before EVERY message and grew for ever. Measured at 900,000
-- entries — a school sending 500/day for five years — it is a 64ms Parallel Seq
-- Scan per message, so 500 messages cost 32 seconds of balance arithmetic. A
-- checkpoint bounds the scan to entries written since it.
ALTER TABLE "message_credit_entry" ADD COLUMN "providerRef"  TEXT;
ALTER TABLE "message_credit_entry" ADD COLUMN "balanceAfter" INTEGER;

-- The balance read: newest checkpoint for a school, then the tail after it.
CREATE INDEX IF NOT EXISTS "message_credit_entry_schoolId_createdAt_idx"
  ON "message_credit_entry" ("schoolId", "createdAt");

-- Reconciliation matches our debits to the provider's message ids.
CREATE INDEX IF NOT EXISTS "message_credit_entry_providerRef_idx"
  ON "message_credit_entry" ("providerRef");

-- The checkpoint LOOKUP, which the balance read does first.
--
-- Measured: with only the (schoolId, createdAt) index above, the tail sum went
-- from 70ms to 0.18ms — and finding the checkpoint became the new bottleneck at
-- 44ms, a Parallel Seq Scan, because nothing covered `reason`. Half a fix reads
-- like no fix at all on the total.
--
-- PARTIAL, because checkpoints are one row per school per sweep against a
-- ledger of every message ever sent: the index stays kilobytes while the table
-- grows for ever. 44ms -> 0.135ms.
CREATE INDEX IF NOT EXISTS "message_credit_entry_checkpoint_idx"
  ON "message_credit_entry" ("schoolId", "createdAt")
  WHERE reason = 'CHECKPOINT';
