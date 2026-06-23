# Dead & Wounded — Gaming Platform Architecture & Spec

> Master design document for the Dead & Wounded competitive gaming platform.
> This is the single source of truth for all game modes. Build incrementally,
> one category at a time, on top of a single shared scoring engine.
> Pair this with the project's CLAUDE.md (security, multi-tenancy, RBAC rules).

---

## 1. Overview

Dead & Wounded is a number-guessing game (in the Bulls & Cows / Mastermind
family). Players pick a secret number of N distinct digits (N = 4, 5, or 6 by
difficulty); opponents guess it and receive a **dead** score (right digit, right
position) and a **wounded** score (right digit, wrong position) until someone
scores N dead (all positions correct).

This platform wraps that single mechanic in five game modes, integrated into the
multi-tenant School Management System (SMS). The scoring logic never changes
across modes — only the *orchestration* (how many secrets exist, who targets
whom, how a winner is decided, and who can administer it).

---

## 2. The shared core: scoring engine (built first, standalone)

This is the foundation every mode depends on. It is a **pure, framework-
independent module** with no I/O, no database, no network — just functions.

### Rules
- A secret/guess is exactly **N** digits, each 0–9, **all distinct** (no
  repeats). N is the **difficulty length** (see Difficulty Levels below).
- `score(guess, secret)` returns `{ dead, wounded }` (both numbers must be the
  same length N):
  - **dead** = positions where `guess[i] === secret[i]`.
  - **wounded** = digits in `guess` that exist in `secret` but at a different
    position, EXCLUDING any digit already counted as dead.
  - A digit counted as dead is never also counted as wounded.
  - `dead + wounded` never exceeds N.
- **Win** = a guess scoring `dead === N` (and therefore `wounded === 0`).

### Difficulty levels (variable length) — BUILD IN FROM THE START
The engine takes `length` as a parameter; it does NOT hard-code 4. Supported
difficulties: **4, 5, or 6 distinct digits.**
- The scoring logic is identical for any N — it compares two equal-length
  sequences of distinct digits. Only the length changes.
- Constraint: distinct digits over the 0–9 alphabet caps the maximum length at
  10. 4/5/6 are well within range.
- Search-space scaling (why difficulty is meaningful):
  - 4 digits → 5,040 possible secrets
  - 5 digits → 30,240 possible secrets
  - 6 digits → 151,200 possible secrets
  Each step up multiplies difficulty ~5–6x — good for age/skill segmentation.
- **Difficulty is a property of the GAME/COMPETITION, not the player.** All
  players in a given match, race, league, or tournament use the SAME length, so
  scores are comparable. You never mix a 4-digit player against a 6-digit one.
- **Leaderboards and tournaments are segmented by difficulty.** A 4-digit
  league and a 6-digit league are separate competitions with separate standings.
- UI impact is trivial: render N input cells instead of 4.

### Canonical test cases
- N=4: `secret = 1920`, `guess = 0127` → `dead = 1, wounded = 2`.
  (Position 3 matches: 2. Misplaced-but-present: 0 and 1.)
- Also test N=5 and N=6 cases, plus: full win (`dead === N`), all-wounded /
  zero-dead, no matches, and rejection of inputs with repeated digits or wrong
  length.

### Why pure
Because all five modes call the same `score()` and `isWin()` functions, the
engine must be reusable and provably correct in isolation. Build it with
exhaustive unit tests across all three lengths BEFORE any networking,
persistence, or UI.

---

## 3. SMS integration model

The standalone game is built first with no SMS dependency. When folded into the
SMS, all game modes (except the cross-school Ultimate mode) inherit the SMS
foundation:

- **Multi-tenancy:** every game record carries `school_id`. Students only see
  and join games within their own school. Enforced by Postgres RLS, exactly as
  the rest of the SMS.
- **Identity:** players are SMS users (students); games reference `userId`.
- **RBAC:** game administration uses the SMS permission system (see §8).
- **Privacy:** players are shown by **display name**, never by exposing other
  student PII. Secrets live server-side only and are never sent to an opponent's
  client.
- **Audit:** game creation, scheduling, and moderation actions are audit-logged
  like other SMS mutations.

The **Ultimate (cross-school) mode is the deliberate exception** to tenant
isolation and is handled specially — see §7.

---

## 4. Category 1 — Elimination Ring (everyone vs everyone, circular)

### Concept
N players arranged in a ring. Each player targets the next player's secret:
P1 → P2, P2 → P3, …, Pn → P1. On your turn you guess your current target's
number. Crack it and that player is **eliminated**. Play continues until one
player remains — the winner.

### Ring re-closing rule (CONFIRMED)
When a player is eliminated, the ring re-closes: **the cracker now targets
whoever the eliminated player was targeting.** Example: in P1→P2→P3→P1, if P1
cracks P2, then P2 is removed and P1's new target becomes P3 (P2's old target).
The ring shrinks by one and stays a closed loop.

### Inherited history rule (RESOLVED)
When a player cracks their target, the cracker gains **read access to the
eliminated player's guess history for that session only**, revealed
**immediately on elimination** (it is the reward for the crack and informs the
cracker's next target). Scope it tightly:
- Only that game session's guess/score records.
- Only the eliminated player's guesses (and the scores they received).
- NEVER any other data about the eliminated student.

### Turn flow (RESOLVED)
- Fixed turn order around the ring; enforce server-side. A player cannot guess
  out of turn.
- **Turn timer: 60 seconds per turn, with a warning at 15 seconds remaining.**
  Long enough to reason about a guess, short enough to prevent stalling.

### Disconnect / timeout handling (RESOLVED)
- On a turn timeout: **skip the turn for the first two misses; forfeit on the
  third consecutive miss.** A hard disconnect lasting over 2 minutes also
  forfeits.
- Rationale: pure skip lets a player stall the ring indefinitely; pure instant-
  forfeit punishes a brief network blip too harshly (relevant for students on
  unreliable mobile connections). The graduated rule balances both.

### Edge cases to handle
- 2 players left: the ring is just A→B, B→A — collapses naturally into a duel.
- Simultaneous-feeling play is not required; this mode is turn-based.
- All players in a ring use the same difficulty length (4, 5, or 6).

### State (per session)
- `players[]` (ordered ring), each with `userId`, `secret` (server-only),
  `targetId`, `eliminated` flag, `guessHistory[]`.
- `currentTurnPlayerId`, `status` (lobby | active | finished), `winnerId`.

---

## 5. Category 2 — Class Race (teacher-hosted, real-time)

### Concept
One shared target secret per class. All students in a class race to crack it.
**First three to score N dead win** (1st, 2nd, 3rd places). N is the race's
difficulty length (4, 5, or 6), fixed for all participants.

### Roles & setup
- A **teacher** opens a race for their class, choosing the difficulty length.
  The target secret is set by the system (random, valid), the teacher, or a
  designated host.
- All students in that class can join the live race.
- A **principal** can schedule a race **tournament across multiple classes.**

### Cross-class tournament rules (RESOLVED)
- **Per-class targets, NOT a single shared target.** A single target across
  classes is unfair and leak-prone: it could pass between classrooms, and
  classes playing at different times face different conditions. Each class gets
  its own freshly generated target of the same difficulty.
- **Combined standings via a normalized, time-independent metric.** Rank across
  the tournament by **(1) fewest guesses to crack, then (2) fastest elapsed time
  from that student's own race start** — NOT raw wall-clock, so a class playing
  at 9am isn't unfairly compared by clock-time to one playing at 2pm.
- Keep **both** per-class standings and a combined tournament leaderboard.
- All classes in one tournament use the same difficulty length.

### Play
- Students guess on their own (parallel, not strict turns — everyone races).
- Each student sees only **their own** dead/wounded feedback and history.
- No student ever sees the target or another student's guesses mid-race.
- The system ranks finishers by who reaches N dead first; top 3 are the winners.

### State
- `targetSecret` (server-only), `difficultyLength`, `participants[]` with
  per-student `guessHistory[]`, `guessCount`, `finishedAt`/`elapsedMs`/`rank`,
  `status`, `winners[1..3]`.
- For tournaments: a parent `tournamentId` grouping multiple class races (each
  with its own target) plus aggregate normalized standings.

### Anti-abuse
- Rate-limit guesses (no scripted rapid-fire).
- Server computes all scores and finish order; clients are display-only.

---

## 6. Category 3 — School League / Knockout

### Concept
A school-wide competition over a defined period. Two formats (support both):
- **League:** students play many 2-player matches over the period; standings by
  points/wins. (Round-robin-ish.)
- **Knockout:** students are randomly matched into 2-player matches; winners
  advance through rounds to a final.

This mode reuses the **base 2-player engine unchanged** — it is matchmaking +
bracket/standings logic layered on top.

### Setup & administration
- A **school-admin or principal** creates a league/tournament: defines the
  period, format, eligibility (which students/classes), and rounds.
- Random matchmaking pairs students; each pairing is a standard 2-player game.

### Scoring, byes & timing (RESOLVED)
- **League points: 3 for a win, 0 for a loss.** Dead & Wounded always produces a
  winner, so draws don't occur in a match. Tiebreakers on equal points, in
  order: (1) fewest total guesses across all matches, (2) head-to-head result.
- **Knockout byes:** with an odd number of players in a round, the bye goes to
  the **highest-standing/seeded player**; if the field is unseeded, assign byes
  randomly — but **never give the same player two byes** in one competition.
- **Match time windows: each match has a 48-hour window** within its round to be
  played. A reminder notification fires at the halfway mark (24h). If a player
  fails to show by the window's close, they **forfeit**; if both fail, the
  higher-standing player advances (knockout) or both get 0 (league).
- All matches in one competition use the same difficulty length (4, 5, or 6);
  difficulty is set at competition creation. Separate difficulties = separate
  competitions.

### Components to build
- **Matchmaking:** random pairing within eligibility, avoiding repeat pairings
  in knockout.
- **Bracket engine:** rounds, advancement, byes for odd counts, final.
- **Standings/leaderboard:** per-school, updated as matches complete, segmented
  by difficulty.
- **Scheduling:** matches open/close within the defined period; handle no-shows
  (timeout → forfeit per the rules above).

### State
- `competition` (type: league|knockout, period, status, schoolId).
- `matches[]` (each a 2-player game instance with `roundNumber`).
- `standings[]` / `bracket` structure.

---

## 7. Category 4 — Ultimate (cross-school) — HANDLE WITH CARE

### Concept
All students across **all schools** compete in one grand competition.

### Why this is special
The entire SMS is built to keep School A's data invisible to School B (RLS,
`school_id` isolation, three-layer defense). The Ultimate mode is the ONE
feature that intentionally crosses that boundary. It must NOT become a hole in
the tenant wall.

### Format (RESOLVED)
- **Leaderboard race, NOT knockout.** A cross-school knockout demands tight
  synchronous scheduling across institutions with different timetables and
  timezones — operationally painful and exclusionary to schools that can't play
  at a mandated time. A leaderboard race (crack the target in fewest guesses
  within a multi-day window) lets every school participate on its own schedule.
- Ranking: **(1) fewest guesses to crack, then (2) fastest elapsed time from
  that student's own start** — the same time-independent metric as Cat 2, so
  schools in different timezones compete fairly.
- Difficulty is fixed per Ultimate competition and segmented (a 4-digit Ultimate
  and a 6-digit Ultimate are separate events).

### Real-name vs handle policy (RESOLVED)
- **Handles only — never real names.** Cross-school surfaces display a
  student-chosen handle (moderated for appropriateness) plus, optionally, the
  school name for grouping. Real names never cross the tenant boundary. This is
  the correct privacy posture for minors competing across institutions.

### Consent mechanism (RESOLVED) — two-tier
1. **School-level enrollment:** a school-admin (or principal) explicitly enrolls
   the school into a given Ultimate competition. No school participates by
   default.
2. **Per-student guardian consent flag:** a student only appears on any cross-
   school surface if their record carries a `crossSchoolConsent = true` flag,
   set via guardian/school consent per the SMS's NDPR-aligned consent system.
   Absent consent, the student cannot enter the Ultimate, even if their school
   is enrolled.
- Both tiers must be satisfied. Consent state is audit-logged.

### Required isolation discipline
- Build it as a **separate cross-tenant arena surface**, reached only through a
  **super-admin-controlled pathway**. It is not a normal school-scoped game.
- The cross-school game records may reference only the **minimum**: an
  anonymized/opaque player id, the chosen **handle**, `school_id` for grouping/
  leaderboard, the secret (server-only), and game scores.
- It must NEVER expose or join against any other student PII, class data, or
  school data. No tenant data leaks through the arena.
- The cross-tenant tables/queries are explicitly separate from the RLS-protected
  per-school tables. Document exactly which fields cross the boundary and why.

### Administration
- Only **super-admin** (platform level) can create/schedule the Ultimate
  competition and decide which schools may participate.
- Per-school opt-in AND per-student consent are required before any student
  appears (see consent mechanism above).

---

## 8. Category 5 — Administration, rights & privileges (per school)

Game administration uses the SMS RBAC system. Permissions are fine-grained
strings scoped by `school_id` (except super-admin, which is cross-tenant).

### Role → capability matrix

| Capability | Student | Teacher | Principal | School-Admin | Super-Admin |
|---|---|---|---|---|---|
| Play games they're entered in | ✅ | ✅ | — | — | — |
| Open a Class Race | — | ✅ (own classes) | ✅ | ✅ | ✅ |
| Schedule cross-class race tournament | — | — | ✅ | ✅ | ✅ |
| Create School League/Knockout | — | — | ✅ | ✅ | ✅ |
| Moderate / end a game, remove a player | — | ✅ (own) | ✅ | ✅ | ✅ |
| View school leaderboards/standings | ✅ (own school) | ✅ | ✅ | ✅ | ✅ |
| Manage game settings for the school | — | — | partial | ✅ | ✅ |
| Enroll school into Ultimate (cross-school) | — | — | ✅ (consent) | ✅ | ✅ |
| Create/schedule the Ultimate competition | — | — | — | — | ✅ |
| Configure cross-school participation rules | — | — | — | — | ✅ |

### Permission strings (FINALIZED — define in packages/types)
Each is a constant; roles map to permission sets. All are `school_id`-scoped
except the two `ultimate.*.admin`/super-admin ones.

```
game.play                  — join and play games one is entered in
game.race.open             — open a Class Race for a class
game.race.tournament       — schedule a cross-class race tournament
game.league.create         — create a school League or Knockout
game.match.moderate        — moderate/end a game, remove a player
game.leaderboard.read      — view leaderboards/standings
game.settings.manage       — manage school-wide game settings/config
game.ultimate.enroll       — enroll the school into an Ultimate competition
game.ultimate.consent      — manage per-student cross-school consent flags
game.ultimate.admin        — create/schedule/configure Ultimate (super-admin)
```

### Principal vs School-Admin split (RESOLVED)
The guiding line: **School-Admin owns CONFIGURATION and school-wide SETUP;
Principal owns OPERATIONS and SCHEDULING** (and can do everything a teacher can).
- **School-Admin** (configuration/governance): `game.settings.manage` (the only
  role besides super-admin that configures school-wide game behavior),
  `game.league.create`, `game.ultimate.enroll`, `game.ultimate.consent`, plus
  all operational permissions. Owns the school's game policy.
- **Principal** (operations): `game.race.tournament`, `game.league.create`,
  `game.match.moderate`, `game.race.open`, `game.leaderboard.read`, and
  `game.ultimate.enroll`. Schedules and runs competitions but does NOT set
  school-wide configuration (`game.settings.manage`).
- **Teacher:** `game.play`, `game.race.open` (own classes), `game.match.moderate`
  (own games), `game.leaderboard.read`.
- **Student:** `game.play`, `game.leaderboard.read` (own school).
- **Super-Admin:** all of the above cross-tenant, plus `game.ultimate.admin`.

### Role → capability matrix (updated)

| Capability | Student | Teacher | Principal | School-Admin | Super-Admin |
|---|---|---|---|---|---|
| Play games they're entered in | ✅ | ✅ | — | — | — |
| Open a Class Race | — | ✅ (own classes) | ✅ | ✅ | ✅ |
| Schedule cross-class race tournament | — | — | ✅ | ✅ | ✅ |
| Create School League/Knockout | — | — | ✅ | ✅ | ✅ |
| Moderate / end a game, remove a player | — | ✅ (own) | ✅ | ✅ | ✅ |
| View school leaderboards/standings | ✅ (own school) | ✅ | ✅ | ✅ | ✅ |
| Manage school-wide game settings/config | — | — | — | ✅ | ✅ |
| Enroll school into Ultimate | — | — | ✅ | ✅ | ✅ |
| Manage per-student cross-school consent | — | — | — | ✅ | ✅ |
| Create/schedule/configure Ultimate | — | — | — | — | ✅ |

### Scoping beyond role
- A teacher opens/moderates races only for **their own classes**.
- A principal/school-admin operates only within **their own school**.
- All reads/writes remain `school_id`-scoped except the Ultimate arena, which is
  super-admin-gated and operates on the separate cross-tenant surface.

---

## 9. Cross-cutting concerns (all modes)

### Server authority (non-negotiable)
- Secrets are stored **server-side only** and never transmitted to opponents.
- Scoring, turn order, finish order, and win detection are computed on the
  **server**. Clients are display-only and never trusted for game logic.
- Validate every secret and guess server-side (N distinct digits 0–9, where N
  is the game's difficulty length of 4, 5, or 6).

### Real-time
- Use WebSockets (Socket.IO or native ws) for live turn/score/standing updates.
- All state transitions are server-driven and broadcast to the relevant players.

### Fair play / anti-abuse
- Rate-limit guesses; turn timers in turn-based modes (Cat 1) and reasonable
  guess pacing in races.
- Disconnect handling: define pause/skip/forfeit per mode with timeouts.

### Persistence
- Standalone first version: in-memory game state is acceptable, but isolate it
  behind a storage interface so it can be swapped for Postgres later.
- SMS-integrated version: persist to Postgres with `school_id` on every
  tenant-scoped table and RLS policies, per CLAUDE.md.

### Minors' data & privacy
- Game telemetry and any cross-school visibility involve minors and are
  sensitive: consent-gated, audit-logged, retention-bounded, transparent.
- Default to display names / pseudonyms; never leak student PII through games.

---

## 10. Persistence model (step 3 onward — SMS integration)

Steps 1–2 are stateless / in-memory by design (see §9). From step 3 (SMS
integration) on, durable game data is persisted to **Postgres**, every
tenant-scoped table carrying a non-null `school_id` with RLS, following the
built-module pattern in CLAUDE.md (relationship scoping, 404-not-403, audited
mutations, an RLS-e2e cross-tenant case, new-table mechanics via
`prisma/rls/NN_*.sql` + `docker-entrypoint.sh`).

### What stays in memory vs. what is persisted
- **In-memory (transient, per live session):** the active turn pointer,
  socket/connection state, countdown timers, and the live "current game" object
  while a match/race is in progress. These are rebuildable and don't need to
  survive a restart mid-game (though persisting enough to RESUME is a nice-to-
  have, not required).
- **Persisted (durable):** everything a player, teacher, or leaderboard refers to
  AFTER a game ends — results, winners, standings, history. This is the data your
  question is about. Listed below.

### Durable tables (all tenant-scoped: non-null `school_id` + RLS)
- **`Game`** — one row per game instance (any mode). Fields: `id`, `school_id`,
  `mode` (DUEL | RING | RACE | LEAGUE_MATCH | KNOCKOUT_MATCH | ULTIMATE),
  `difficultyLength` (4|5|6), `status` (lobby|active|finished|abandoned),
  `createdBy`, `startedAt`, `finishedAt`, optional `competitionId` (FK when the
  game belongs to a tournament/league/knockout).
- **`GamePlayer`** — a player's participation in one game. Fields: `gameId`,
  `userId` (the student), `secretHash`/`secret` (server-only — NEVER exposed to
  opponents), `targetId` (Ring mode), `eliminated`, `joinedAt`. The secret is
  retained only as long as needed; consider clearing/obscuring it once the game
  is finished.
- **`Guess`** — the durable guess history (replaces in-memory history at game
  end, or written through during play). Fields: `gameId`, `guesserId`,
  `targetId` (whose secret was guessed), `value`, `dead`, `wounded`,
  `createdAt`. This is what powers post-game review and the Ring "inherited
  history" reward.
- **`GameResult`** — the outcome / WINNERS. Fields: `gameId`, `userId`, `rank`
  (1st/2nd/3rd for races; winner/loser for duels), `guessCount`, `elapsedMs`
  (from that player's own start, for fair cross-time ranking), `outcome`
  (WON | LOST | ELIMINATED | FORFEIT). One row per participant.
- **`Competition`** — a league, knockout, race tournament, or Ultimate event.
  Fields: `id`, `school_id` (NULL/sentinel for the cross-school Ultimate — see
  caveat), `type` (LEAGUE | KNOCKOUT | RACE_TOURNAMENT | ULTIMATE),
  `difficultyLength`, `period` (start/end), `status`, `createdBy`. Games link
  back via `Game.competitionId`.
- **`Standing`** — the durable leaderboard rows for a competition. Fields:
  `competitionId`, `userId`, `points` (3/0 league scheme), `wins`, `losses`,
  `totalGuesses` (tiebreaker), `rank`, `roundNumber` (knockout). Recomputed/
  updated as games in the competition finish.
- **`ConsentFlag` / reuse of the SMS consent system** — the per-student
  `crossSchoolConsent` gate for Ultimate (§7). Prefer reusing the existing SMS
  consent tables rather than a new one if they fit.

### Cross-school Ultimate — separate surface (spec §7)
The Ultimate competition deliberately crosses the tenant boundary, so its durable
data lives on the **separate, super_admin-gated cross-tenant surface**, NOT the
per-school RLS tables. It persists only the minimum: opaque player id, chosen
**handle** (never real name), `school_id` for grouping, the secret (server-only),
guesses, and results/standings. It must never join against or expose any other
tenant data. Document exactly which columns cross the boundary and why.

### Retention & audit
- Game records about minors fall under Golden Rule #5: audited and
  retention-bounded. Decide a retention window for finished-game detail (guesses,
  secrets) vs. durable results/standings (which may be kept longer as a record of
  achievement). Secrets in particular should not be retained indefinitely.
- All result-writing and standings updates are audited like other SMS mutations.

---

## 11. Recommended build sequence

1. **Scoring engine (standalone, pure module + exhaustive tests).** ← build now.
2. **Standalone 2-player online game** (WebSockets, server-authoritative) on top
   of the engine.
3. **SMS integration of the 2-player game** (login, `school_id`, RLS, persist
   state per §10 Persistence model). Establishes the integration pattern.
4. **Category 3 — League/Knockout** (matchmaking + brackets reuse 2-player).
5. **Category 2 — Class Race** (teacher-hosted, parallel, top-3).
6. **Category 1 — Elimination Ring** (ring + re-close + inherited history).
7. **Category 5 — Administration/RBAC** (woven in as each mode lands; formalize
   the permission set here).
8. **Category 4 — Ultimate (cross-school)** LAST, on its deliberately separate
   cross-tenant arena, super-admin-gated, with consent and pseudonymity.

Rationale: each step reuses the proven core and the previous step's patterns.
The cross-tenant Ultimate mode is built last, once isolation discipline is
well established, so it can be carved out cleanly without weakening the tenant
wall.

---

## 12. Decisions status

All major open decisions are now RESOLVED inline in their sections:
- **Cat 1:** 60s turn timer (15s warning); graduated disconnect (skip ×2 →
  forfeit on 3rd, or >2min hard disconnect); inherited history revealed
  immediately on elimination, session-scoped. → §4
- **Cat 2:** per-class targets; combined standings via normalized metric (fewest
  guesses, then fastest own-start elapsed time); both per-class and combined
  leaderboards. → §5
- **Cat 3:** 3-for-win / 0-for-loss with guess-count then head-to-head
  tiebreakers; bye to highest standing (or random, never twice); 48h match
  window with 24h reminder, forfeit on no-show. → §6
- **Cat 4:** leaderboard race (not knockout); handles only, never real names;
  two-tier consent (school enrollment + per-student guardian consent flag). → §7
- **Cat 5:** permission strings finalized; School-Admin owns configuration,
  Principal owns operations/scheduling. → §8
- **Difficulty:** 4/5/6 distinct digits, set per game/competition, leaderboards
  segmented by length. → §2

### Minor settings to tune at build time (not blockers)
- Exact guess rate-limit thresholds per mode.
- Handle moderation approach (blocklist vs review) for cross-school play.
- League period length and number of rounds (per competition).
- Whether Cat 2 tournaments allow mixed difficulties across classes (default:
  no — one difficulty per tournament).