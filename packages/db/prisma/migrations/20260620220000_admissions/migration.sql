-- Admissions: public application intake. RLS in 17_admissions_rls.sql.
CREATE TYPE "AdmissionStatus" AS ENUM ('NEW', 'REVIEWING', 'ACCEPTED', 'REJECTED');
CREATE TABLE "admission_application" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "applicantName" TEXT NOT NULL,
    "applicantEmail" TEXT NOT NULL,
    "applicantPhone" TEXT,
    "childName" TEXT NOT NULL,
    "childDob" DATE,
    "notes" TEXT,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'NEW',
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_application_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admission_application_schoolId_idx" ON "admission_application"("schoolId");
CREATE INDEX "admission_application_schoolId_status_idx" ON "admission_application"("schoolId", "status");
ALTER TABLE "admission_application" ADD CONSTRAINT "admission_application_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
