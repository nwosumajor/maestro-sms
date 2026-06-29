-- School-wide announcements. A principal/school_admin posts a notice; students
-- and parents read their school's ALL/STUDENTS notices. Tenant-scoped; RLS +
-- grants in prisma/rls/35_announcements_rls.sql (applied separately).

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'STUDENTS', 'STAFF');

-- CreateTable
CREATE TABLE "announcement" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "AnnouncementAudience" NOT NULL DEFAULT 'ALL',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "announcement_schoolId_idx" ON "announcement"("schoolId");
CREATE INDEX "announcement_schoolId_createdAt_idx" ON "announcement"("schoolId", "createdAt");
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
