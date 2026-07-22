# Classroom games engines

> New classroom game suite (live quiz / typing race / hangman / chess / checkers) — PHASE 1 pure engines in packages/game-engine BUILT + tested (168 engine tests green); SMS integration (schema/RLS/service/controller/web/seed) per game still TODO; 2026-07-14 UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

User asked to build 5 new games with difficulty levels: **Kahoot-style live quiz**
(Geography/Science/Art/Literature/General themes), **typing race**, **hangman**,
**chess**, **checkers**. Following the Dead & Wounded spec's build order (pure
engine first, exhaustively tested, THEN SMS integration).

**Phase 1 DONE + verified** (packages/game-engine/src, all pure/framework-free):
- `difficulty.ts` — shared `GAME_DIFFICULTIES` EASY/MEDIUM/HARD scale +
  `BOARD_TIME_CONTROLS` (chess/checkers difficulty = time control, rules never change).
- `quiz.ts` — `scoreQuizAnswer` (Kahoot linear speed decay 1.0→0.5 + capped streak
  bonus), `QUIZ_THEMES`, `QUIZ_DIFFICULTY_SPECS`, `rankQuizStandings`. Answer index
  server-only.
- `typing.ts` — `computeTypingResult` (per-position correctness, 5-char WPM,
  net=gross*accuracy), `TYPING_DIFFICULTY_SPECS`, `rankTypingStandings`.
- `hangman.ts` — immutable state machine: `newHangmanState`/`guessLetter`/
  `maskedWord`/`livesRemaining`; difficulty = lives + word-length band.
- `checkers.ts` — 8x8 English draughts: mandatory captures, DFS multi-jump chains,
  kinging (ends move), win-by-no-move. NAMESPACED export.
- `chess.ts` — full rules: legal moves, check/checkmate/stalemate, castling
  (not-through-check), en passant, promotion (4 options), insufficient-material +
  50-move draw. NAMESPACED export.
- GOTCHA: chess & checkers both export `Sq`/`legalMoves`/`applyMove`/`movesEqual`,
  so index.ts uses `export * as chess` / `export * as checkers` (NOT flat) →
  consumers call `chess.legalMoves(...)`. Others stay flat `export *`.
Verified: 168/168 engine tests (50 new incl. fool's-mate CHECKMATE, stalemate,
castling blocked-through-check, en-passant, promotion, multi-jump); game-engine
tsc exit 0; monorepo turbo typecheck 13/13.

**Phase 2 TODO (per game, the standard built-module pattern):** tenant-scoped
tables + non-null school_id + `prisma/rls/NN_*.sql` + docker-entrypoint apply_rls
+ RLS e2e cross-tenant case; service w/ relationship scoping (404-not-403) +
audited mutations; controller w/ `@RequirePermission`+`@RequireModule`; new
`game.*` perms in @sms/types + seed; web screens; live push via GameEventsService/
`/ws/watch`. Quiz also needs a themed question bank (teacher-authored + seeded
defaults) and reuses the LMS quiz content + live bridge. Recommended integration
order: live quiz (highest value) → hangman/typing (simplest) → checkers → chess.
See [dead-and-wounded-game](dead-and-wounded-game.md) for the reference module pattern. UNCOMMITTED.
