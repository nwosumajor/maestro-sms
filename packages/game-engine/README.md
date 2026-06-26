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
- **Step 4 — competition (`src/competition.ts`)**: pure League/Knockout
  matchmaking, brackets, byes & standings (and `computeRaceStandings`).
- **Step 5 — race (`src/race.ts`)**: the server-authoritative `Race` state
  machine for Category 2 (spec §5) — one shared target, parallel (turn-less) play,
  finish-order ranking, top-3 (or all-cracked) ends the race. The target is never
  serialized and is cleared on finish; a racer's view carries only their own
  guesses; the leaderboard is finishers only. Guess rate-limiting (anti-abuse §5)
  is a transport concern, like turn timers. The SMS module
  (`apps/api/src/game/race.service.ts`) and the WebSocket transport drive this
  core; cross-class tournament ranking layers `computeRaceStandings` above it.
- **Step 8 — arena (`src/arena.ts`)**: the `Arena` state machine — the PURE,
  governance-free core of the cross-school "Ultimate" (spec §7). Rolling solo
  entry by HANDLE (never a real name); each participant gets their OWN per-entry
  target and races their own clock (`enter` reserves a seat, `begin` starts the
  clock after the transport's get-ready countdown, `guess` cracks their own
  target); finishers rank together by the §5 metric (fewest guesses → fastest
  own-start elapsed) via `computeRaceStandings`. PII-free: only opaque ids,
  handles, server-only secrets, and scores — the consent/enrollment/bridge
  governance lives ABOVE it in `apps/api/src/game/ultimate.service.ts`.
- **Step 6 — ring (`src/ring.ts`)**: the server-authoritative `Ring` state
  machine for Category 1 (spec §4) — N-player ring, turn order, the crack →
  eliminate → **ring re-close** (cracker inherits the victim's target), the §4
  **inherited-history** reward (a victim's guesses revealed only to whoever
  cracked them), and the graduated turn timeout (skip ×2 → forfeit on the 3rd).
  Like `Duel`, time is injected and timers live in the transport; secrets are
  never serialized. The SMS module (`apps/api/src/game/ring.service.ts`) and the
  WebSocket transport both drive this same core.

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

Built: the scoring engine (step 1), the 2-player match core + storage seam
(step 2; the WebSocket server is `apps/game-server`), the League/Knockout
competition logic (step 4), the Class `Race` core (step 5), the Elimination
`Ring` core (step 6), and the Ultimate `Arena` core (step 8). The SMS integration /
Postgres persistence (step 3 onward) lives in `apps/api/src/game`, which drives
these pure cores. The `apps/game-server` transport serves the duel, ring, and
race; an arena socket transport (with the §10 15s get-ready countdown) is the
next wiring job.
