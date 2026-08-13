-- "Which discipline cases am I responsible for?"
--
-- An assignee could not see the case they had been assigned: both the list and
-- the by-id read scoped to manager-or-complainant, and `assigneeId` was written
-- and never read by anything. Fixing that adds a lookup BY assignee, and the
-- existing unique leads on complaintId so it cannot serve one — without this
-- index the query scans every assignment the school has ever made.
CREATE INDEX IF NOT EXISTS "discipline_assignee_schoolId_assigneeId_idx"
    ON "discipline_assignee" ("schoolId", "assigneeId");
