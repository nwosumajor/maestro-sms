# Typing Race module

> Typing Race (classroom typing game) FULLY built + live-verified + COMMITTED (branch feat/games-typing-checkers-chess, cc9c543): 2 tenant tables (typing_race/racer), RLS file 67, service/controller, game.typing.host perm, engine WPM scoring server-side, passage shown (not secret); web host form + play screen at /games/typing. 3rd of 5 games DONE.

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Third classroom game ([classroom-games-engines](classroom-games-engines.md)) integrated, RaceService
pattern (teacher hosts for class, students race in PARALLEL, ranked by net WPM →
accuracy → finish time). Follows [hangman-module](hangman-module.md) closely.

**BUILT + verified (backend + web):**
- Schema `typing_race.prisma`: `TypingRace` (classId/hostId/difficulty/passage/
  status/winner) + `TypingRacer` (netWpm/accuracy/progress/finished/rank; netWpm
  & accuracy are Float/DOUBLE PRECISION). Migration `20260714030000_typing_race`,
  RLS file `67_typing_race_rls.sql` (sentinel `typing_racer_update`, entrypoint),
  School back-relations.
- `TypingRaceService`/`Controller` in apps/api/src/game (wired GameModule). Perm
  `game.typing.host` (seeded teacher/principal/school_admin). DTOs
  `packages/types/src/dto/typing-race.ts`. Scoring via `@sms/game-engine`
  typing.ts (computeTypingResult / rankTypingStandings / TYPING_DIFFICULTY_SPECS).
- KEY: the passage is SHOWN (players type it) — NOT a secret, no redaction. WPM/
  accuracy/finish computed SERVER-SIDE from (passage, reported typed, server-
  measured elapsed from race start); client never self-reports speed. Progress
  endpoint is idempotent/throttled — updates live metrics; on full correct type →
  finished + row-locked rank; all-finished → race auto-finishes.
- Web: `/games/typing` (list + `OpenTypingForm`) + `/games/typing/[id]`
  (`TypingPlay`: per-char correctness highlight, throttled progress POST ~700ms,
  live WPM + progress bars, leaderboard). Hub card. `usePolled` 1.5s.
- Verified LIVE: 2 RLS cross-tenant cases + coverage gate green, api+web build
  (76 routes), functional smoke (partial progress→accuracy drop→finish rank #1→
  auto-finish→404/403 denial), 2-role route smoke, real-data web E2E. Test data
  cleaned. COMMITTED cc9c543.

GOTCHA reminder: route-smoke.mjs resolves the app dir relative to CWD — run it
from `apps/web`, not repo root (else ENOENT on app/(app)).

**Branch feat/games-typing-checkers-chess:** cc9c543 typing race.
**Remaining:** checkers, chess (engines built+tested; turn-based 2-player — plan:
duel model, no enforced clock in v1, board-game time controls deferred).
