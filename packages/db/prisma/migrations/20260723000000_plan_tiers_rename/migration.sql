-- Plan tiers changed to STANDARD / PREMIUM / ULTIMATE / ENTERPRISE.
-- The old free floor BASIC no longer exists -> map any BASIC rows to STANDARD (the
-- new floor). STANDARD/ENTERPRISE names are unchanged; PREMIUM/ULTIMATE are new.
-- `plan` is a free-text column (validated in app), so this is a data update only.
UPDATE "school_subscription" SET "plan" = 'STANDARD' WHERE "plan" = 'BASIC';
UPDATE "platform_subscription_payment" SET "plan" = 'STANDARD' WHERE "plan" = 'BASIC';
