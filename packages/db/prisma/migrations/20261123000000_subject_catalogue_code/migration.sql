-- The concept a subject is, when it came from the shared catalogue.
--
-- NULL means the school typed this one itself. That is a first-class state, not
-- a gap: custom subjects keep working exactly as before, and every subject that
-- exists today is one, so this backfills to NULL and changes nothing.
--
-- The catalogue is a TEMPLATE that is copied. This column is the only link back,
-- deliberately: a shared row that class_subject_teacher pointed at would have no
-- school_id for RLS to scope, and one school's rename would change another's
-- report cards.
ALTER TABLE "subject" ADD COLUMN "catalogueCode" TEXT;

-- Cross-school questions ("how many schools teach Further Mathematics") group on
-- this, and the picker checks it per school to mark what is already added.
CREATE INDEX "subject_catalogueCode_idx" ON "subject" ("catalogueCode");
