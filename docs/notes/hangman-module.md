# Hangman Module

> Hangman (classroom letter-guessing) FULLY built, live-verified, COMMITTED (branch feat/classroom-games, 650fd26 backend + 20e8e54 web): 2 tenant tables, RLS file 65, service/controller, game.hangman.host perm, engine rules; word hidden while live + REVEALED on finish; web host form + play screen at /games/hangman. 2nd of 5 games DONE.

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Second of the 5 new games ([classroom-games-engines](classroom-games-engines.md)) integrated, mirroring
the RaceService pattern (teacher hosts for a class, students play their OWN board
of a shared server-only word in PARALLEL, ranked by fewest wrong then earliest).

**BUILT + live-verified (backend + web):**
- Schema `hangman.prisma`: `HangmanGame` (classId/hostId/difficulty/word/status/
  winnerUserId) + `HangmanPlayer` (guessed JSON, wrong, status PLAYING/WON/LOST,
  rank). Migration `20260714010000_hangman`, RLS file `65_hangman_rls.sql`
  (sentinel `hangman_player_update`, registered in entrypoint), School
  back-relations.
- `HangmanService`/`Controller` in apps/api/src/game (wired into GameModule).
  Perm `game.hangman.host` (GAME_PERMISSIONS + role arrays + seeded to teacher/
  principal/school_admin). DTOs `packages/types/src/dto/hangman.ts`.
- Rules run in `@sms/game-engine` hangman.ts: the service RECONSTRUCTS each
  player's engine state from (word, guessed) via newHangmanState+fold guessLetter
  — engine stays the single source of truth. Difficulty sets lives (EASY 8/
  MEDIUM 6/HARD 5) + a built-in `WORD_BANK` (host may supply a custom word).
- KEY DESIGN vs race: the word is server-only WHILE LIVE (players see only the
  MASKED word) but is REVEALED + RETAINED on finish (the answer is the payoff —
  do NOT null it like a race target). DTO `word` is null until status FINISHED.
- Web: `/games/hangman` (index: open/active list + host `OpenHangmanForm`) +
  `/games/hangman/[id]` (`HangmanPlay`: masked slots, A–Z keyboard with hit/miss
  colouring, lives, host start/end, leaderboard). `usePolled` 1.5s. Hub card added.
- Verified LIVE + COMMITTED: migrate deploy, RLS applied (2 tables), 2 RLS
  cross-tenant cases + coverage gate green, api build clean, functional smoke
  (open→join→start→wrong guess costs a life→dup 409→solve CAT→auto-FINISH→word
  REVEALED→rank #1→guess-after-finish 409→parent denied), web tsc + build (74
  routes), 2-role route smoke, real-data web E2E (word absent from page HTML).
  Committed on branch feat/classroom-games (650fd26 backend, 20e8e54 web).

**Branch feat/classroom-games commits so far:** bf2a917 engines · 2f93c8a quiz
backend · 38c3e4f quiz web · 650fd26 hangman backend · 20e8e54 hangman web.
**Remaining games:** typing race, checkers, chess (engines already tested).
