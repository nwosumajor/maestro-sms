-- Typing Race (classroom typing game). Tenant-scoped tables; RLS applied
-- separately (packages/db/prisma/rls/67_typing_race_rls.sql), never in-migration.

-- CreateEnum
CREATE TYPE "TypingRaceStatus" AS ENUM ('LOBBY', 'ACTIVE', 'FINISHED');

-- CreateTable
CREATE TABLE "typing_race" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "difficulty" TEXT NOT NULL,
    "passage" TEXT NOT NULL,
    "status" "TypingRaceStatus" NOT NULL DEFAULT 'LOBBY',
    "winnerUserId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "typing_race_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "typing_racer" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "raceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "netWpm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accuracy" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "elapsedMs" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "finishedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "typing_racer_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "typing_race_schoolId_idx" ON "typing_race"("schoolId");
CREATE INDEX "typing_race_schoolId_status_idx" ON "typing_race"("schoolId", "status");
CREATE INDEX "typing_race_schoolId_classId_idx" ON "typing_race"("schoolId", "classId");
CREATE INDEX "typing_racer_schoolId_idx" ON "typing_racer"("schoolId");
CREATE UNIQUE INDEX "typing_racer_raceId_userId_key" ON "typing_racer"("raceId", "userId");

-- Foreign keys
ALTER TABLE "typing_race" ADD CONSTRAINT "typing_race_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_racer" ADD CONSTRAINT "typing_racer_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typing_racer" ADD CONSTRAINT "typing_racer_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "typing_race"("id") ON DELETE CASCADE ON UPDATE CASCADE;
