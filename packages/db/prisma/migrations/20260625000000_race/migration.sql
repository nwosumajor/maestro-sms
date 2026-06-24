-- Dead & Wounded Class Race (Cat 2, spec §5, step 5): a RACE is a Game with one
-- shared server-only target secret and a class link. Reuses the `game`/
-- `game_player`/`guess`/`game_result` tables (RLS in 18_game_rls.sql already
-- covers them — new columns inherit the table's row policies), so no new RLS file.
ALTER TABLE "game" ADD COLUMN "classId" UUID;
ALTER TABLE "game" ADD COLUMN "targetSecret" TEXT;
CREATE INDEX "game_schoolId_classId_idx" ON "game"("schoolId", "classId");
