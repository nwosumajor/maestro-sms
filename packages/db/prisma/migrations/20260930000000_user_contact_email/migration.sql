-- User.contactEmail — the real, deliverable address.
--
-- `user.email` stays the globally-unique LOGIN IDENTIFIER (login happens before a
-- school is known, so it must be global). New accounts get a GENERATED identifier
-- scoped by the school's own unique slug, which removes the cross-school
-- collision. That identifier has no mailbox, so delivery moves here.
--
-- Nullable and NOT unique, deliberately:
--   * students usually have no address of their own (guardians are notified),
--   * one parent may legitimately use a single address for several children.
--
-- Backfill: existing users' `email` IS their real address, so it is copied over.
-- Anything generated later is excluded by construction (it did not exist yet).
ALTER TABLE "user" ADD COLUMN "contactEmail" TEXT;

UPDATE "user" SET "contactEmail" = "email" WHERE "contactEmail" IS NULL;

-- Delivery looks up by contactEmail; an index keeps that cheap at fleet scale.
CREATE INDEX "user_contactEmail_idx" ON "user" ("contactEmail");
