-- Which payment rails the platform will START a charge on. GLOBAL, operator-owned.
-- One row (id = 'default'), same posture as platform_fee_config / plan_price.
CREATE TABLE "payment_channel_config" (
  "id"        TEXT NOT NULL,
  "enabled"   JSONB NOT NULL,
  "note"      TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_channel_config_pkey" PRIMARY KEY ("id")
);

-- Seed the startup default: Paystack only. Written here rather than left to the
-- application so a fresh deployment has a defined posture from its first boot,
-- and so the row exists for the operator screen to edit rather than create.
INSERT INTO "payment_channel_config" ("id", "enabled", "note", "updatedAt")
VALUES ('default', '["PAYSTACK"]'::jsonb, 'Startup default: Paystack only.', now())
ON CONFLICT ("id") DO NOTHING;
