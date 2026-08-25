-- WHAT A SCHOOL PAID FOR ITS MESSAGE CREDITS WAS NEVER RECORDED.
--
-- Bundles are sold through Paystack like any other platform charge. The
-- settlement path read the amount off the gateway event, checked it against the
-- bundle's price so a short payment could not credit a bundle -- and then wrote
-- a ledger row carrying the CREDITS GRANTED and nothing about the money.
--
-- The consequences were not cosmetic. The operator's revenue ledger reads
-- `platform_subscription_payment`, which message credits never touch, so this
-- revenue line appeared on no screen in the product; and because the figure was
-- never persisted, it could not be recovered from our own database at all --
-- only from the gateway's.
--
-- NULLABLE on all three: a SEND, an ADJUST and a CHECKPOINT are not payments
-- and must not carry a price, and purchases written before this column existed
-- cannot say what they were. NULL here means "not a recorded payment", which is
-- a different statement from zero.
ALTER TABLE "message_credit_entry" ADD COLUMN "amountMinor" INTEGER;
ALTER TABLE "message_credit_entry" ADD COLUMN "currency" TEXT;
ALTER TABLE "message_credit_entry" ADD COLUMN "bundleId" TEXT;

-- The operator ledger asks for PURCHASE rows across the whole fleet, newest
-- first. Without this it is a sequential scan of every credit movement the
-- platform has ever recorded -- a table that grows with every message sent, not
-- with the number of purchases.
CREATE INDEX "message_credit_entry_purchase_idx"
  ON "message_credit_entry" ("createdAt" DESC)
  WHERE reason = 'PURCHASE';
