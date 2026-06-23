-- Dead & Wounded game: durable records (spec §10). RLS in 18_game_rls.sql.
CREATE TYPE "GameMode" AS ENUM ('DUEL', 'RING', 'RACE', 'LEAGUE_MATCH', 'KNOCKOUT_MATCH', 'ULTIMATE');
CREATE TYPE "GameStatus" AS ENUM ('LOBBY', 'SETUP', 'ACTIVE', 'FINISHED', 'ABANDONED');
CREATE TYPE "GameOutcome" AS ENUM ('WON', 'LOST', 'ELIMINATED', 'FORFEIT');

CREATE TABLE "game" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "mode" "GameMode" NOT NULL DEFAULT 'DUEL',
    "difficultyLength" INTEGER NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'LOBBY',
    "createdById" UUID NOT NULL,
    "currentTurnPlayerId" UUID,
    "winnerPlayerId" UUID,
    "competitionId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "game_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "game_schoolId_idx" ON "game"("schoolId");
CREATE INDEX "game_schoolId_status_idx" ON "game"("schoolId", "status");

CREATE TABLE "game_player" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "secret" TEXT,
    "targetId" UUID,
    "eliminated" BOOLEAN NOT NULL DEFAULT false,
    "consecutiveMisses" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "game_player_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "game_player_gameId_userId_key" ON "game_player"("gameId", "userId");
CREATE INDEX "game_player_schoolId_idx" ON "game_player"("schoolId");
CREATE INDEX "game_player_schoolId_gameId_idx" ON "game_player"("schoolId", "gameId");

CREATE TABLE "guess" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "guesserId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "value" TEXT NOT NULL,
    "dead" INTEGER NOT NULL,
    "wounded" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guess_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "guess_schoolId_idx" ON "guess"("schoolId");
CREATE INDEX "guess_schoolId_gameId_idx" ON "guess"("schoolId", "gameId");

CREATE TABLE "game_result" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "guessCount" INTEGER NOT NULL,
    "elapsedMs" INTEGER,
    "outcome" "GameOutcome" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "game_result_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "game_result_gameId_userId_key" ON "game_result"("gameId", "userId");
CREATE INDEX "game_result_schoolId_idx" ON "game_result"("schoolId");

ALTER TABLE "game" ADD CONSTRAINT "game_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_player" ADD CONSTRAINT "game_player_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_player" ADD CONSTRAINT "game_player_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guess" ADD CONSTRAINT "guess_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guess" ADD CONSTRAINT "guess_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_result" ADD CONSTRAINT "game_result_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_result" ADD CONSTRAINT "game_result_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
