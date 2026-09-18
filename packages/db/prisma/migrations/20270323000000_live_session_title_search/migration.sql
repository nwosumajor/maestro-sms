-- SEARCHING A TOPIC MUST NOT SCAN THE SCHOOL'S WHOLE HISTORY.
--
-- `/live-classes` searches the topic with a case-insensitive contains, which no
-- btree can serve — so it read every session the school had ever scheduled and
-- filtered in the heap. Measured on ten years of a heavy-recording school
-- (31,201 sessions, 28,471 for the school under test):
--
--   without      19.6 ms   Bitmap Heap Scan, 28,471 rows read to return 93
--   with trigram  2.9 ms   Bitmap Index Scan, 112 index rows read
--
-- That is the difference between O(the school's LIFETIME) and O(the matches) —
-- the shape this codebase records as the one that degrades invisibly, on the
-- interaction a pupil revising uses most.
--
-- The write cost is the reason to check rather than assume: a GIN index is
-- expensive to maintain, and this one is 1.2 MB against a 6.7 MB heap on a
-- table that takes a few thousand INSERTs a YEAR (one per scheduled lesson).
-- Cheap where it is paid, and paid almost never.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "lms_live_session_title_trgm_idx"
  ON "lms_live_session" USING gin ("title" gin_trgm_ops);
