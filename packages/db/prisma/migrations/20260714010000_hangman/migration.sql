-- Hangman (classroom letter-guessing). Tenant-scoped tables; RLS applied
-- separately (packages/db/prisma/rls/65_hangman_rls.sql), never in-migration.

-- CreateEnum
CREATE TYPE "HangmanGameStatus" AS ENUM ('LOBBY', 'ACTIVE', 'FINISHED');

-- CreateTable
CREATE TABLE "hangman_game" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "difficulty" TEXT NOT NULL,
    "word" TEXT,
    "status" "HangmanGameStatus" NOT NULL DEFAULT 'LOBBY',
    "winnerUserId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hangman_game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hangman_player" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "guessed" JSONB NOT NULL,
    "wrong" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PLAYING',
    "rank" INTEGER,
    "solvedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hangman_player_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "hangman_game_schoolId_idx" ON "hangman_game"("schoolId");
CREATE INDEX "hangman_game_schoolId_status_idx" ON "hangman_game"("schoolId", "status");
CREATE INDEX "hangman_game_schoolId_classId_idx" ON "hangman_game"("schoolId", "classId");
CREATE INDEX "hangman_player_schoolId_idx" ON "hangman_player"("schoolId");
CREATE UNIQUE INDEX "hangman_player_gameId_userId_key" ON "hangman_player"("gameId", "userId");

-- Foreign keys
ALTER TABLE "hangman_game" ADD CONSTRAINT "hangman_game_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hangman_player" ADD CONSTRAINT "hangman_player_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hangman_player" ADD CONSTRAINT "hangman_player_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "hangman_game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
