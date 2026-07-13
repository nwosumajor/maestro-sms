-- Public onboarding intake: the requester can now record a desired subscription
-- tier + add-on modules. Wish-only fields (the operator decides at provisioning);
-- global table, no RLS change.
ALTER TABLE "onboarding_request"
  ADD COLUMN "desiredPlan" TEXT,
  ADD COLUMN "desiredModules" JSONB;
