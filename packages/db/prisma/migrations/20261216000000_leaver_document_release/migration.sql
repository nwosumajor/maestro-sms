-- A leaver's documents, and the principal's decision to release them.
--
-- Schools commonly withhold a transcript or a leaving certificate until the
-- family has settled what they owe. The platform had no way to record that
-- decision, so it happened outside the system or not at all.
--
-- Gates ACADEMIC artefacts only. It deliberately does not gate the
-- data-protection export: a data subject's right to their own personal data is
-- not a debt-collection lever, and withholding it over money is unlawful.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "docsReleasedAt"   TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "docsReleasedById" UUID;
