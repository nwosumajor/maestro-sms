-- CBT mock-exam hall: question banks, questions (answerIndex server-only),
-- scheduled exams, and per-student sittings. RLS in rls/75_cbt_rls.sql.

CREATE TABLE "cbt_question_bank" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cbt_question_bank_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cbt_question_bank_schoolId_idx" ON "cbt_question_bank"("schoolId");
ALTER TABLE "cbt_question_bank" ADD CONSTRAINT "cbt_question_bank_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cbt_question" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "choices" JSONB NOT NULL,
    "answerIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cbt_question_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cbt_question_schoolId_bankId_idx" ON "cbt_question"("schoolId", "bankId");
ALTER TABLE "cbt_question" ADD CONSTRAINT "cbt_question_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cbt_question" ADD CONSTRAINT "cbt_question_bankId_fkey"
    FOREIGN KEY ("bankId") REFERENCES "cbt_question_bank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "cbt_exam" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "classId" UUID,
    "questionCount" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "shuffle" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cbt_exam_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cbt_exam_schoolId_status_idx" ON "cbt_exam"("schoolId", "status");
ALTER TABLE "cbt_exam" ADD CONSTRAINT "cbt_exam_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cbt_exam" ADD CONSTRAINT "cbt_exam_bankId_fkey"
    FOREIGN KEY ("bankId") REFERENCES "cbt_question_bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cbt_sitting" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "questionIds" JSONB NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "score" INTEGER,
    "total" INTEGER,
    CONSTRAINT "cbt_sitting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cbt_sitting_examId_studentId_key" ON "cbt_sitting"("examId", "studentId");
CREATE INDEX "cbt_sitting_schoolId_examId_idx" ON "cbt_sitting"("schoolId", "examId");
ALTER TABLE "cbt_sitting" ADD CONSTRAINT "cbt_sitting_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cbt_sitting" ADD CONSTRAINT "cbt_sitting_examId_fkey"
    FOREIGN KEY ("examId") REFERENCES "cbt_exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
