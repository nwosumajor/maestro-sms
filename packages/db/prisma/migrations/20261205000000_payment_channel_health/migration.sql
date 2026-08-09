-- Last health-check result per payment channel, so the daily sweep can alert on
-- a TRANSITION (working -> broken) instead of repeating the same alarm nightly,
-- and the operator screen can show the last known truth without calling a
-- gateway just to render a page.
ALTER TABLE "payment_channel_config" ADD COLUMN IF NOT EXISTS "health" JSONB;
