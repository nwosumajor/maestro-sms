-- Append-only version history for LMS content (edit/revert + clone source).
-- Tenant-scoped; RLS grants SELECT/INSERT only (see rls/54).
CREATE TABLE "lms_content_revision" (
  "id"        UUID NOT NULL,
  "schoolId"  UUID NOT NULL,
  "contentId" UUID NOT NULL,
  "version"   INTEGER NOT NULL,
  "type"      TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "body"      JSONB NOT NULL DEFAULT '{}',
  "note"      TEXT,
  "authorId"  UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lms_content_revision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lms_content_revision_schoolId_idx" ON "lms_content_revision"("schoolId");
CREATE INDEX "lms_content_revision_schoolId_contentId_idx" ON "lms_content_revision"("schoolId","contentId");
