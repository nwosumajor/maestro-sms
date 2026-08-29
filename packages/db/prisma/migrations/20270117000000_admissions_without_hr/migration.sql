-- Admissions no longer route through the HR manager.
--
-- ADMISSION_REVIEW_CHAIN was ADMIN -> HR -> PRINCIPAL, copied from
-- STAFF_REQUEST_CHAIN. That chain is right for a STAFF request, because HR owns
-- employment; admitting a CHILD is not an employment decision.
--
-- WHY A DATA MIGRATION AND NOT JUST THE CONSTANT. The resolved chain is STORED
-- on each application (`stages`) at creation, and `currentStage` is an INDEX
-- into it — deliberately, so an application in flight is decided by the route it
-- started on rather than by whatever the constant says today. Without this, every
-- pending application would go on waiting for an approver the policy no longer
-- has: the school removes the HR step and the queue silently keeps it.
--
-- ONLY PENDING ROWS. An ACCEPTED or REJECTED application is a finished record
-- and its route is part of that record. And the `approvals` log — who actually
-- decided what, and when — is a separate column and is never touched here, so
-- this rewrites the ROUTE and not the EVIDENCE.
--
-- The index shifts with the array: a row awaiting HR (index 1 of three) becomes
-- one awaiting the principal (index 1 of two), and a row already at the
-- principal (index 2) would otherwise point past the end of a two-stage chain.
--
-- Idempotent: the WHERE clause matches only rows that still carry an HR stage.

WITH shrunk AS (
  SELECT a.id,
         (SELECT ord - 1
            FROM jsonb_array_elements(a.stages) WITH ORDINALITY t(elem, ord)
           WHERE elem->>'key' = 'HR'
           LIMIT 1) AS hr_index,
         COALESCE(
           (SELECT jsonb_agg(elem ORDER BY ord)
              FROM jsonb_array_elements(a.stages) WITH ORDINALITY t(elem, ord)
             WHERE elem->>'key' <> 'HR'),
           '[]'::jsonb) AS remaining
    FROM admission_application a
   WHERE a.status IN ('NEW', 'REVIEWING')
     AND a.stages @> '[{"key": "HR"}]'::jsonb
)
UPDATE admission_application a
   SET stages = shrunk.remaining,
       "currentStage" = CASE
         WHEN a."currentStage" > shrunk.hr_index THEN a."currentStage" - 1
         ELSE a."currentStage"
       END
  FROM shrunk
 WHERE shrunk.id = a.id;
