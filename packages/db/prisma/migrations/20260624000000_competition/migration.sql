-- Dead & Wounded League/Knockout: competitions + standings (spec §6/§10, step 4).
-- RLS in 19_competition_rls.sql (applied separately). Adds round/deadline + the
-- competition FK to `game` (the FK column already exists from the step-3 migration).
CREATE TYPE "CompetitionType" AS ENUM ('LEAGUE', 'KNOCKOUT', 'RACE_TOURNAMENT', 'ULTIMATE');
CREATE TYPE "CompetitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'FINISHED', 'CANCELLED');

CREATE TABLE "competition" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "type" "CompetitionType" NOT NULL,
    "name" TEXT NOT NULL,
    "difficultyLength" INTEGER NOT NULL,
    "status" "CompetitionStatus" NOT NULL DEFAULT 'DRAFT',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "currentRound" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "competition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competition_schoolId_idx" ON "competition"("schoolId");
CREATE INDEX "competition_schoolId_status_idx" ON "competition"("schoolId", "status");

CREATE TABLE "standing" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "totalGuesses" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "roundNumber" INTEGER,
    "eliminated" BOOLEAN NOT NULL DEFAULT false,
    "byes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "standing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "standing_competitionId_userId_key" ON "standing"("competitionId", "userId");
CREATE INDEX "standing_schoolId_idx" ON "standing"("schoolId");
CREATE INDEX "standing_schoolId_competitionId_idx" ON "standing"("schoolId", "competitionId");

-- Game additions for competition matches.
ALTER TABLE "game" ADD COLUMN "roundNumber" INTEGER;
ALTER TABLE "game" ADD COLUMN "deadlineAt" TIMESTAMP(3);
CREATE INDEX "game_competitionId_idx" ON "game"("competitionId");

ALTER TABLE "competition" ADD CONSTRAINT "competition_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standing" ADD CONSTRAINT "standing_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "standing" ADD CONSTRAINT "standing_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game" ADD CONSTRAINT "game_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
