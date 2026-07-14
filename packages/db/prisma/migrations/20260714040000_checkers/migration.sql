-- Checkers (turn-based 2-player). Tenant-scoped; RLS applied separately
-- (packages/db/prisma/rls/68_checkers_rls.sql), never in-migration.

-- CreateEnum
CREATE TYPE "CheckersStatus" AS ENUM ('LOBBY', 'ACTIVE', 'FINISHED');

-- CreateTable
CREATE TABLE "checkers_game" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "status" "CheckersStatus" NOT NULL DEFAULT 'LOBBY',
    "createdById" UUID NOT NULL,
    "blackUserId" UUID NOT NULL,
    "whiteUserId" UUID,
    "turn" TEXT NOT NULL DEFAULT 'b',
    "board" JSONB NOT NULL,
    "moveCount" INTEGER NOT NULL DEFAULT 0,
    "winnerUserId" UUID,
    "outcome" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "checkers_game_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "checkers_game_schoolId_idx" ON "checkers_game"("schoolId");
CREATE INDEX "checkers_game_schoolId_status_idx" ON "checkers_game"("schoolId", "status");

-- Foreign keys
ALTER TABLE "checkers_game" ADD CONSTRAINT "checkers_game_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
