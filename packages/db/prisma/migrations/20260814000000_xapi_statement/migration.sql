-- xAPI (Tin Can) Learning Record Store: append-only, immutable learning
-- statements. Tenant-scoped; RLS in rls/57 (SELECT/INSERT only).
CREATE TABLE "xapi_statement" (
  "id"         UUID NOT NULL,
  "schoolId"   UUID NOT NULL,
  "actorId"    UUID NOT NULL,
  "verb"       TEXT NOT NULL,
  "objectId"   TEXT NOT NULL,
  "objectName" TEXT NOT NULL,
  "classId"    UUID,
  "result"     JSONB NOT NULL DEFAULT '{}',
  "storedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "xapi_statement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "xapi_statement_schoolId_idx" ON "xapi_statement"("schoolId");
CREATE INDEX "xapi_statement_schoolId_classId_idx" ON "xapi_statement"("schoolId","classId");
CREATE INDEX "xapi_statement_schoolId_actorId_idx" ON "xapi_statement"("schoolId","actorId");
