-- Chess (turn-based 2-player). Tenant-scoped; RLS applied separately
-- (packages/db/prisma/rls/69_chess_rls.sql), never in-migration.

-- CreateEnum
CREATE TYPE "ChessStatus" AS ENUM ('LOBBY', 'ACTIVE', 'FINISHED');

-- CreateTable
CREATE TABLE "chess_game" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "status" "ChessStatus" NOT NULL DEFAULT 'LOBBY',
    "createdById" UUID NOT NULL,
    "whiteUserId" UUID NOT NULL,
    "blackUserId" UUID,
    "turn" TEXT NOT NULL DEFAULT 'w',
    "board" JSONB NOT NULL,
    "castling" JSONB NOT NULL,
    "ep" JSONB,
    "halfmove" INTEGER NOT NULL DEFAULT 0,
    "fullmove" INTEGER NOT NULL DEFAULT 1,
    "chessStatus" TEXT NOT NULL DEFAULT 'PLAYING',
    "moveCount" INTEGER NOT NULL DEFAULT 0,
    "winnerUserId" UUID,
    "outcome" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chess_game_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "chess_game_schoolId_idx" ON "chess_game"("schoolId");
CREATE INDEX "chess_game_schoolId_status_idx" ON "chess_game"("schoolId", "status");

-- Foreign keys
ALTER TABLE "chess_game" ADD CONSTRAINT "chess_game_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
