-- "One active X per person" was enforced only in code.
--
-- Four services read to decide and then insert, with nothing in between:
--
--   hostel_allocation          "Student already has an active hostel allocation"
--   transport_assignment       "Passenger already has an active transport assignment"
--   staff_exit                 "An exit for this employee is already awaiting a decision"
--   employment_change_request  "An identical request is already awaiting a decision"
--
-- Two requests arriving together both read a clear record and both succeed. The
-- same race was proved live on the invigilator roster, where it put one person
-- in two halls at nine o'clock; here it puts a boarder in two beds, a passenger
-- on two routes, and — on the two maker-checker paths — two settlements or two
-- pay changes awaiting approval for the same person, either of which is money.
--
-- A PARTIAL UNIQUE INDEX, not a lock. The invigilator clash needed a lock
-- because "does any row overlap this window" is not something an index can
-- express. THIS rule is exactly an index: one row per person among those in the
-- active state. Declarative, enforced against every writer for ever — including
-- a future code path and a manual fix at 2am — and free at read time.
--
-- The code guards STAY: they produce the sentence a user reads. The index is
-- what makes those sentences true when two people press at once, and each
-- service now turns the resulting P2002 into the same message.
--
-- Prisma has no syntax for a partial unique index (`@@unique` takes no `where`),
-- so these live here, like the trigram indexes added for search.
--
-- If this migration FAILS on a live database, it has found real duplicates
-- rather than caused them: resolve them (close the older row) and re-run. On
-- this one there were none in any of the four tables.
CREATE UNIQUE INDEX IF NOT EXISTS "hostel_allocation_one_active_per_student"
  ON "hostel_allocation" ("studentId") WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS "transport_assignment_one_active_per_passenger"
  ON "transport_assignment" ("passengerId") WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS "staff_exit_one_pending_per_user"
  ON "staff_exit" ("userId") WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS "employment_change_request_one_pending_per_user_type"
  ON "employment_change_request" ("userId", "type") WHERE status = 'PENDING';
