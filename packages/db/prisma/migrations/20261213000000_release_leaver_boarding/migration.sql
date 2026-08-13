-- A pupil who has left the school keeps neither a bed nor a bus seat.
--
-- Exiting a pupil closed their account and every enrolment, but never touched
-- the hostel allocation or the route assignment. Those two lists are not
-- paperwork: the allocation list IS the night roll call, and the assignment
-- list IS the driver's manifest. A departed child on either means staff looking
-- for someone who is not there.
--
-- They also held a bed and a seat a real boarder could not be given, and the
-- rent run bills on ACTIVE allocations — verified live, a pupil whose exit two
-- people had approved was invoiced for the next month's boarding.
--
-- StudentExitService now closes both in the same transaction as the exit. This
-- backfills the rows that were left behind before that existed. History is
-- retained in both tables: the row stays, its status moves.
UPDATE "hostel_allocation" a
   SET status = 'VACATED'
  FROM "user" u
 WHERE u.id = a."studentId"
   AND a.status = 'ACTIVE'
   AND u.status <> 'ACTIVE';

UPDATE "transport_assignment" t
   SET status = 'CANCELLED'
  FROM "user" u
 WHERE u.id = t."passengerId"
   AND t.status = 'ACTIVE'
   AND u.status <> 'ACTIVE';
