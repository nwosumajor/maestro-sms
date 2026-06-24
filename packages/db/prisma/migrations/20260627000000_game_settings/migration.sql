-- Dead & Wounded per-school game configuration (spec §8/§12, step 7). Tenant-
-- scoped (one row per school); RLS in 20_game_settings_rls.sql (applied
-- separately). school_admin manages it via `game.settings.manage`; the game
-- services read the effective values.
CREATE TABLE "game_settings" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "gamesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultDifficulty" INTEGER NOT NULL DEFAULT 4,
    "guessRateLimitMs" INTEGER NOT NULL DEFAULT 750,
    "ringTurnLimitSec" INTEGER NOT NULL DEFAULT 60,
    "leagueMatchWindowHours" INTEGER NOT NULL DEFAULT 48,
    "crossSchoolEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "game_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "game_settings_schoolId_key" ON "game_settings"("schoolId");
CREATE INDEX "game_settings_schoolId_idx" ON "game_settings"("schoolId");

ALTER TABLE "game_settings" ADD CONSTRAINT "game_settings_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
