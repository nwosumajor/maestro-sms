-- One award per position per programme, enforced by the database ------------
--
-- "Best Three" means at most three awardees, each at a distinct position, and
-- each position carries its own award amount. That was enforced only by reading
-- the already-awarded rows and checking in application code — a read-then-write
-- across two different applications, which no per-row claim can serialise.
--
-- The race did NOT reproduce over HTTP: two simultaneous awards at position 1,
-- then three at position 2, were each correctly refused. The window is narrow.
-- That is a reason to close it cheaply rather than to call it safe — the same
-- verdict this repo reached on the library-return race it hardened anyway. Here
-- the consequence is money and a promise to a family about where their child
-- placed.
--
-- PARTIAL, on status = 'AWARDED', because awardPosition is meaningless on any
-- other row and a plain unique index would collide across rejected candidates.
-- Not expressible in the Prisma schema (partial indexes are not), so it lives
-- here in SQL like the cbt_sitting GIN index.
CREATE UNIQUE INDEX IF NOT EXISTS "scholarship_application_programId_awardPosition_key"
  ON "scholarship_application" ("programId", "awardPosition")
  WHERE status = 'AWARDED';
