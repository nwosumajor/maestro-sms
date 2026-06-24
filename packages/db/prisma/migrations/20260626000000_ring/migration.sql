-- Dead & Wounded Elimination Ring (Cat 1, spec §4, step 6). Reuses the
-- `game`/`game_player`/`guess`/`game_result` tables (RLS in 18_game_rls.sql
-- already covers them — new columns inherit the table's row policies), so no new
-- RLS file. Adds:
--   game.turnStartedAt        — server-side 60s turn-limit validation
--   game_player.eliminatedById — scopes the cracker's "inherited history" reward
ALTER TABLE "game" ADD COLUMN "turnStartedAt" TIMESTAMP(3);
ALTER TABLE "game_player" ADD COLUMN "eliminatedById" UUID;
