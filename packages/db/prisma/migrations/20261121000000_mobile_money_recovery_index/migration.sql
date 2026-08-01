-- The mobile-money RECOVERY SWEEP asks the rails about charges no callback ever
-- arrived for. It is cross-tenant by nature — a rail's charges span schools — so
-- it filters on (status, createdAt) and not on schoolId. The existing indexes are
-- both schoolId-leading and cannot serve it, leaving a scheduled sequential scan
-- over a table that only ever grows.
CREATE INDEX IF NOT EXISTS "mobile_money_intent_status_createdAt_idx"
  ON "mobile_money_intent" ("status", "createdAt");
