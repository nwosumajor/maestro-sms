-- Discipline Room: complaints, assignees, evidence, entries. Tenant-scoped. RLS in prisma/rls/42.
CREATE TABLE "discipline_complaint" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL, "subject" TEXT NOT NULL, "details" TEXT,
  "complainantId" UUID NOT NULL, "againstId" UUID NOT NULL, "againstType" TEXT NOT NULL DEFAULT 'STUDENT',
  "status" TEXT NOT NULL DEFAULT 'OPEN', "resolution" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discipline_complaint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discipline_complaint_schoolId_idx" ON "discipline_complaint"("schoolId");
CREATE INDEX "discipline_complaint_schoolId_againstId_idx" ON "discipline_complaint"("schoolId", "againstId");
CREATE TABLE "discipline_assignee" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL, "complaintId" UUID NOT NULL, "assigneeId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discipline_assignee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "discipline_assignee_complaintId_assigneeId_key" ON "discipline_assignee"("complaintId", "assigneeId");
CREATE INDEX "discipline_assignee_schoolId_idx" ON "discipline_assignee"("schoolId");
CREATE TABLE "discipline_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL, "complaintId" UUID NOT NULL, "uploadedById" UUID NOT NULL,
  "fileKey" TEXT NOT NULL, "fileName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discipline_evidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discipline_evidence_schoolId_idx" ON "discipline_evidence"("schoolId");
CREATE INDEX "discipline_evidence_schoolId_complaintId_idx" ON "discipline_evidence"("schoolId", "complaintId");
CREATE TABLE "discipline_entry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schoolId" UUID NOT NULL, "complaintId" UUID NOT NULL, "authorId" UUID NOT NULL, "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discipline_entry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "discipline_entry_schoolId_idx" ON "discipline_entry"("schoolId");
CREATE INDEX "discipline_entry_complaintId_idx" ON "discipline_entry"("complaintId");
ALTER TABLE "discipline_assignee" ADD CONSTRAINT "discipline_assignee_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "discipline_complaint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discipline_evidence" ADD CONSTRAINT "discipline_evidence_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "discipline_complaint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discipline_entry" ADD CONSTRAINT "discipline_entry_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "discipline_complaint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
