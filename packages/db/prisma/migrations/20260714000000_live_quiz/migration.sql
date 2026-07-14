-- Live Quiz (Kahoot-style, curriculum-themed). Tenant-scoped tables; RLS applied
-- separately (packages/db/prisma/rls/64_live_quiz_rls.sql), never in-migration.

-- CreateEnum
CREATE TYPE "LiveQuizStatus" AS ENUM ('LOBBY', 'ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "live_quiz" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "live_quiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_quiz_question" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "quizId" UUID NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "choices" JSONB NOT NULL,
    "answerIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_quiz_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_quiz_session" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "quizId" UUID NOT NULL,
    "classId" UUID,
    "hostId" UUID NOT NULL,
    "status" "LiveQuizStatus" NOT NULL DEFAULT 'LOBBY',
    "currentIndex" INTEGER NOT NULL DEFAULT -1,
    "questionStartedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "live_quiz_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_quiz_participant" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_quiz_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_quiz_answer" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "questionIndex" INTEGER NOT NULL,
    "choiceIndex" INTEGER NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "elapsedMs" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_quiz_answer_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "live_quiz_schoolId_idx" ON "live_quiz"("schoolId");
CREATE INDEX "live_quiz_schoolId_theme_idx" ON "live_quiz"("schoolId", "theme");
CREATE INDEX "live_quiz_question_schoolId_idx" ON "live_quiz_question"("schoolId");
CREATE UNIQUE INDEX "live_quiz_question_quizId_orderIndex_key" ON "live_quiz_question"("quizId", "orderIndex");
CREATE INDEX "live_quiz_session_schoolId_idx" ON "live_quiz_session"("schoolId");
CREATE INDEX "live_quiz_session_schoolId_status_idx" ON "live_quiz_session"("schoolId", "status");
CREATE INDEX "live_quiz_session_schoolId_classId_idx" ON "live_quiz_session"("schoolId", "classId");
CREATE INDEX "live_quiz_participant_schoolId_idx" ON "live_quiz_participant"("schoolId");
CREATE UNIQUE INDEX "live_quiz_participant_sessionId_userId_key" ON "live_quiz_participant"("sessionId", "userId");
CREATE INDEX "live_quiz_answer_schoolId_idx" ON "live_quiz_answer"("schoolId");
CREATE UNIQUE INDEX "live_quiz_answer_sessionId_participantId_questionIndex_key" ON "live_quiz_answer"("sessionId", "participantId", "questionIndex");

-- Foreign keys
ALTER TABLE "live_quiz" ADD CONSTRAINT "live_quiz_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "live_quiz_question" ADD CONSTRAINT "live_quiz_question_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "live_quiz_question" ADD CONSTRAINT "live_quiz_question_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "live_quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_quiz_session" ADD CONSTRAINT "live_quiz_session_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "live_quiz_session" ADD CONSTRAINT "live_quiz_session_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "live_quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_quiz_participant" ADD CONSTRAINT "live_quiz_participant_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "live_quiz_participant" ADD CONSTRAINT "live_quiz_participant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "live_quiz_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_quiz_answer" ADD CONSTRAINT "live_quiz_answer_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "live_quiz_answer" ADD CONSTRAINT "live_quiz_answer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "live_quiz_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
