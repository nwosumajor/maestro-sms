-- Student-lifecycle Phase A: a subject catalog + per-class subject/teacher
-- offerings, plus class progression (level + nextClassId) and a class supervisor.
-- New tenant tables (subject, class_subject_teacher) — RLS + grants in
-- prisma/rls/31_subjects_rls.sql (applied separately). Class gains nullable
-- columns only; the self-relation + supervisor FK are added here.

-- Class: progression + supervisor
ALTER TABLE "class" ADD COLUMN "level" INTEGER;
ALTER TABLE "class" ADD COLUMN "nextClassId" UUID;
ALTER TABLE "class" ADD COLUMN "supervisorId" UUID;

ALTER TABLE "class" ADD CONSTRAINT "class_nextClassId_fkey"
  FOREIGN KEY ("nextClassId") REFERENCES "class"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "class" ADD CONSTRAINT "class_supervisorId_fkey"
  FOREIGN KEY ("supervisorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "class_schoolId_supervisorId_idx" ON "class"("schoolId", "supervisorId");

-- Subject catalog
CREATE TABLE "subject" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "subject_schoolId_idx" ON "subject"("schoolId");
ALTER TABLE "subject" ADD CONSTRAINT "subject_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Per-class subject offering, one teacher per (class, subject)
CREATE TABLE "class_subject_teacher" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_subject_teacher_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "class_subject_teacher_classId_subjectId_key" ON "class_subject_teacher"("classId", "subjectId");
CREATE INDEX "class_subject_teacher_schoolId_idx" ON "class_subject_teacher"("schoolId");
CREATE INDEX "class_subject_teacher_schoolId_teacherId_idx" ON "class_subject_teacher"("schoolId", "teacherId");
ALTER TABLE "class_subject_teacher" ADD CONSTRAINT "class_subject_teacher_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_subject_teacher" ADD CONSTRAINT "class_subject_teacher_classId_fkey"
  FOREIGN KEY ("classId") REFERENCES "class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_subject_teacher" ADD CONSTRAINT "class_subject_teacher_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "class_subject_teacher" ADD CONSTRAINT "class_subject_teacher_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
