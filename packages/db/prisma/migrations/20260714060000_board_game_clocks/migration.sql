-- Board-game time controls: per-player chess clocks for checkers + chess.
-- New columns only (no new tables), so no RLS file change is needed — the
-- existing 68/69 policies already cover these tables.

ALTER TABLE "checkers_game"
  ADD COLUMN "difficulty" TEXT NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN "whiteTimeMs" INTEGER NOT NULL DEFAULT 300000,
  ADD COLUMN "blackTimeMs" INTEGER NOT NULL DEFAULT 300000,
  ADD COLUMN "turnStartedAt" TIMESTAMP(3);

ALTER TABLE "chess_game"
  ADD COLUMN "difficulty" TEXT NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN "whiteTimeMs" INTEGER NOT NULL DEFAULT 300000,
  ADD COLUMN "blackTimeMs" INTEGER NOT NULL DEFAULT 300000,
  ADD COLUMN "turnStartedAt" TIMESTAMP(3);
