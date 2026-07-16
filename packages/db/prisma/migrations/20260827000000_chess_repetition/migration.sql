-- Threefold-repetition support: per-game position-occurrence counts since the
-- last irreversible move. Nullable — existing games start counting from their
-- next move (the engine tolerates a missing map).
ALTER TABLE "chess_game" ADD COLUMN "repetition" JSONB;
