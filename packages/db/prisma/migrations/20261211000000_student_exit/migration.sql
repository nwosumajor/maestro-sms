-- When a pupil's exit was authorised. Null unless status = 'EXITED'.
--
-- Login already refuses any status but ACTIVE, so setting EXITED is what ends a
-- departed pupil's access — previously nothing did, and a withdrawn pupil could
-- still sign in and read class content. EXITED is deliberately distinct from
-- SUSPENDED: a suspension is reversible by one admin, an exit is authorised by a
-- two-stage chain ending with the principal, and one shared value would let
-- whoever can suspend also un-exit and bypass that chain.
ALTER TABLE "user" ADD COLUMN "exitedAt" TIMESTAMP(3);

-- The leavers register: "who has left" over a date range. Partial, because
-- leavers are a small minority of a school's users and only they are scanned.
CREATE INDEX IF NOT EXISTS "user_exited_idx"
  ON "user" ("schoolId", "exitedAt")
  WHERE "status" = 'EXITED';
