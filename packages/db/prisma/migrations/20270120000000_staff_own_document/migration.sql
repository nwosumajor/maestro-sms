-- A member of staff's own document — a sick note, a certificate, a doctor's
-- report — so a leave request can carry the evidence for it.
--
-- `document` could express two things: a document about a PUPIL (`studentId`)
-- and a school-level one (both null), which only school-wide staff may create
-- or read. There was no way to say "this is about ME", so `leave_request
-- .attachmentDocId` — which requires a Vault document the CALLER uploaded — was
-- unreachable for teacher, hr_clerk, warden and librarian: most of the people
-- who take leave.
--
-- Nullable, and mutually exclusive with `studentId` in the service: a document
-- is about a pupil, about a member of staff, or about the school.
ALTER TABLE "document" ADD COLUMN IF NOT EXISTS "staffUserId" UUID;

-- Scalar column + DB FK, no Prisma relation — the documented pattern here that
-- keeps the User model lean. RESTRICT, matching `studentId`'s: a user is never
-- hard-deleted (an exit sets a status), so this forbids nothing the product
-- does while stopping an orphan.
ALTER TABLE "document"
  ADD CONSTRAINT "document_staffUserId_fkey"
  FOREIGN KEY ("staffUserId") REFERENCES "user"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- The read path asks "the documents about this member of staff", so it wants
-- the tenant with it.
CREATE INDEX IF NOT EXISTS "document_schoolId_staffUserId_idx" ON "document"("schoolId", "staffUserId");
