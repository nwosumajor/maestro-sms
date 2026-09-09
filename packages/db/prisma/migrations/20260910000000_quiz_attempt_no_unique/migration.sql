-- The attempt cap was a COUNT followed by an INSERT with nothing between them.
-- At READ COMMITTED two concurrent attempts both count the same number, both
-- pass the cap, and both insert — proven by interleaving the service's own
-- statements in two sessions: a pupil finished with TWO attempts on a
-- one-attempt quiz, both numbered 1.
--
-- The rule is expressible as a constraint, so it becomes one. Two racers both
-- computing attemptNo = 1 now collide, and the loser gets the same 409 the cap
-- guard gives — the guard and the race must not be distinguishable.
--
-- Deduplicate first: keep the earliest row of any group that already shares a
-- number. There are none in ordinary data (checked), but a migration that fails
-- on deploy is worse than one that is defensive.
DELETE FROM "quiz_attempt" a
 USING "quiz_attempt" b
 WHERE a."contentId" = b."contentId"
   AND a."studentId" = b."studentId"
   AND a."attemptNo" = b."attemptNo"
   AND (a."createdAt" > b."createdAt" OR (a."createdAt" = b."createdAt" AND a.id > b.id));

CREATE UNIQUE INDEX "quiz_attempt_contentId_studentId_attemptNo_key"
  ON "quiz_attempt" ("contentId", "studentId", "attemptNo");
