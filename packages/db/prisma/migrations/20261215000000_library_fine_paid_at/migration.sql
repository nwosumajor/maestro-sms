-- A library fine is money the school took. It recorded THAT it was paid and not
-- WHEN: `finePaid` is a boolean, the receipt's date was `new Date()` at print
-- time, and nothing persisted it. So the date lived only in the audit entry, and
-- the receipt could never be re-issued — paying a fine and losing the printout
-- meant there was no way to produce it again.
ALTER TABLE "book_loan" ADD COLUMN IF NOT EXISTS "finePaidAt" TIMESTAMP(3);

-- Backfill what can be known. For fines already marked paid we do not have the
-- moment, but the return is the closest true bound: the fine cannot have been
-- paid before the book came back. Left NULL where even that is unknown rather
-- than inventing a timestamp — a wrong date on a money record is worse than an
-- absent one, and an absent one is visibly absent.
UPDATE "book_loan"
   SET "finePaidAt" = "returnedAt"
 WHERE "finePaid" = true
   AND "finePaidAt" IS NULL
   AND "returnedAt" IS NOT NULL;
