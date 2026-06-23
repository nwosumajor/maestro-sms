# @sms/game-engine

Dead & Wounded — the game **core**. Steps 1–2 of the platform spec
(`DEAD_AND_WOUNDED_PLATFORM_SPEC.md` §11). Deliberately **framework-independent**:
no I/O, no database, no network, no SMS imports — just functions and exhaustive
tests, so it is provably correct in isolation. Every game mode depends on it.

- **Step 1 — scoring (`src/scoring.ts`)**: the pure scoring engine.
- **Step 2 — match (`src/match.ts`) + store (`src/store.ts`)**: the
  server-authoritative 2-player `Duel` state machine (turn order, scoring, win/
  forfeit/timeout, secret redaction) and the swappable `GameStore` seam. The
  WebSocket transport lives separately in `apps/game-server`.

## API (`src/scoring.ts`)

- `validate(input, length)` — `true` iff `input` is exactly `length` characters,
  each digit 0–9, all distinct. `length` is the difficulty (4, 5, or 6) and is
  always a parameter — never hard-coded.
- `score(guess, secret)` — `{ dead, wounded }`. `dead` = right digit/right
  position; `wounded` = right digit/wrong position, excluding dead. Throws on
  malformed input (server-authority discipline, spec §9).
- `isWin(result, length)` — `dead === length` (and therefore `wounded === 0`).
- `generateSecret(length, rng?)` — a uniformly-random valid secret; RNG is
  injectable for deterministic tests (defaults to `Math.random`; production must
  inject a CSPRNG).
- `DIFFICULTY_LENGTHS` / `DifficultyLength` / `isDifficultyLength` — the 4/5/6
  difficulty set.

`DeadWoundedResult` is defined here for now; per spec §10 it will move to
`packages/types/src/dto/` when the game is wired into the SMS.

## Test

```
pnpm --filter @sms/game-engine test
```

## Scope note

Built: the scoring engine (step 1) and the 2-player match core + storage seam
(step 2; the WebSocket server is `apps/game-server`). Deliberately NOT built yet:
SMS integration / Postgres persistence (step 3) and the higher game modes
(league/knockout, class race, elimination ring, ultimate).
