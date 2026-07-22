# Dead & Wounded game

> Dead & Wounded game module build progress against spec §11 sequence

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The Dead & Wounded gaming platform (spec `DEAD_AND_WOUNDED_PLATFORM_SPEC.md`) is being built in the spec §11 order, one step per session.

Done as of 2026-06-23:
- Steps 1–3 (prior "D&W" commit e883c53): pure scoring engine (`packages/game-engine/scoring.ts`), standalone WS 2-player server (`apps/game-server`), and SMS duel integration (`apps/api/src/game`, schema `game.prisma`, RLS `18_game_rls.sql`).
- **Step 4 — Category 3 League/Knockout:** pure bracket/standings in `packages/game-engine/competition.ts`; `CompetitionService`/`CompetitionController`; Prisma models Competition+Standing (migration `20260624000000_competition`, RLS `19_competition_rls.sql`); DTOs in `packages/types/src/dto/competition.ts`; `game.league.create` seeded to principal/school_admin. `GameService.finish` calls `CompetitionService.afterMatchFinished` (one-way dep, no cycle) to recompute league standings / advance knockout brackets; `sweep` forfeits no-shows. Knockout byes are pre-finished single-seat games so advancement = "winner of every game in the round".
- **Step 5 — Category 2 Class Race:** `race.service.ts` + `race.controller.ts`; pure `computeRaceStandings` added to `competition.ts`; schema adds `Game.classId` + server-only `Game.targetSecret` (migration `20260625000000_race`, NO new RLS — reuses game/competition/standing policies); DTOs `packages/types/src/dto/race.ts`; `game.race.open` (teacher/principal/school_admin) + `game.race.tournament` (principal/school_admin) seeded. A RACE is one shared target, parallel play (no turns — does NOT use GameService), first-3-win, per-student guess redaction, own-start elapsedMs, per-racer rate-limit. Cross-class tournament = one RACE per class under `Competition(RACE_TOURNAMENT)`, combined+per-class standings. Teacher-of-class / enrolled-student scoping mirrors AttendanceService (`assertTeacherOfClass`/enrollment, 404-not-403).

- **Step 6 — Category 1 Elimination Ring:** `ring.service.ts` + `ring.controller.ts`; schema adds `Game.turnStartedAt` + `GamePlayer.eliminatedById` (migration `20260626000000_ring`, NO new RLS — reuses game policies); DTOs `packages/types/src/dto/ring.ts`; `game.match.moderate` seeded to teacher/principal/school_admin. Ring re-close on crack (predecessor inherits victim's target), inherited-history reward scoped by `eliminatedById`, one-guess-per-turn server-enforced, 60s limit validated from `turnStartedAt`, graduated timeout (skip ×2 → forfeit on 3rd), last-standing wins, reverse-elimination placings, secrets cleared on finish. Turn-based, owns its lifecycle (NOT via GameService).

- **Step 7 — Category 5 Admin/RBAC (this session):** `game-settings.service.ts` + `game-settings.controller.ts` + `game-settings.util.ts` (defaults/effective merge); schema GameSettings (one row/school: gamesEnabled, defaultDifficulty, guessRateLimitMs, ringTurnLimitSec, leagueMatchWindowHours, crossSchoolEnabled; migration `20260627000000_game_settings`, RLS `20_game_settings_rls.sql`); `game.settings.manage` seeded to school_admin ONLY (principal excluded per §8). Makes settings.manage real: the 4 game services consult `effectiveGameSettings` via a tx helper (no constructor churn) — gamesEnabled gates open/create, defaultDifficulty fills omitted difficulty (difficulty now optional on open/create), race rate-limit + ring turn limit + league window all read from settings. RBAC per-mode now fully woven (only ultimate.* unseeded).

- **Step 8 — Category 4 Ultimate (cross-school), LAST:** `ultimate.service.ts` + `ultimate.controller.ts`; schema `ultimate.prisma` (migration `20260628000000_ultimate`, RLS `21_ultimate_rls.sql`); DTOs `packages/types/src/dto/ultimate.ts`; `game.ultimate.{admin,enroll,consent}` now SEEDED (admin→super_admin; enroll→principal/school_admin; consent→school_admin). The ONE deliberate tenant-boundary crossing, built as a SEPARATE surface with two opposite-posture halves: (A) RLS-EXEMPT cross-tenant arena `UltimateCompetition`/`UltimateParticipant` — explicitly listed in the RLS file like school/role, carries NO PII (opaque participant id, handle, schoolId-for-grouping, server-only secret never serialized, scores); (B) RLS tenant-scoped governance/bridge `UltimateEnrollment`(tier-1 school opt-in)/`UltimateConsent`(tier-2 guardian consent)/`UltimateEntryLink`(the ONLY userId↔participantId map) — so an arena row de-anonymises only within its owning school. Entry needs BOTH consent tiers + `crossSchoolEnabled` (step 7). Wire crossing = handle + school NAME + scores, nothing else. Each player guesses their OWN per-entry target; leaderboard ranks via pure `computeRaceStandings`. RLS-e2e covers only the bridge tables (arena excluded by design).

Verified this session (2026-06-24): `pnpm db:generate` clean with new models, full monorepo `pnpm typecheck` = 11/11 turbo tasks pass, `pnpm --filter @sms/game-engine test` = 81/81 pass. DB e2e/RLS suites (`competition`/`race`/`ring`/`game-settings`.service.e2e-spec.ts + the rls.e2e ultimate case) are gated on `TEST_DATABASE_URL`(app role)/`TEST_ADMIN_URL`(superuser) and run in CI — the local sandbox Postgres rejects all available creds, so they could not run here. Everything (steps 4–8) is still UNCOMMITTED in the working tree.

The full spec §11 sequence (steps 1–8) is now COMPLETE. Build pattern follows [lms-module](lms-module.md) / CLAUDE.md (tenant-scoped + RLS + relationship scoping + 404-not-403 + audited).

**Game web UI — BUILT (2026-06-24 session):** `apps/web/app/(app)/games/*` + `apps/web/components/game/*`. Nav item "Games" in AppShell gated on `game.leaderboard.read`. Hub `/games` (Quick Duel + Ring start buttons, open-duels join list, teacher Class-Race opener, Leagues/Knockouts list + create form, Ultimate link, GameSettings form). Play screens POLL the BFF (`/api/sms/...`) — REST-only, NO live sockets (those stay step-2 transport): `/games/duel/[id]` (DuelPlay), `/games/ring/[id]` (RingPlay), `/games/race/[id]` (RacePlay), `/games/league/[id]` (server-rendered standings+matches→duel screen), `/games/ultimate` + `/games/ultimate/[id]` (UltimatePlay + UltimateAdmin enroll/consent/create). Shared client primitives in `components/game/play-ui.tsx`: `GuessForm`/`GuessList`/`ScorePips`/`usePolled`/`postSms`/`digitsValid`. **FULL-STACK VERIFIED 2026-06-24** against a real Postgres 18 cluster I stood up in-sandbox (initdb→trust auth→port 5544; system pg was inaccessible). Ran the real entrypoint sequence: migrate deploy → all 21 RLS files (ON_ERROR_STOP clean) → seed. ENTIRE api jest suite GREEN: 22 suites / 165 tests (all modules + RLS cross-tenant + 5 game modes + new GET /races); game-engine 81/81; monorepo typecheck 11/11; web production build compiles all 7 game routes. CRITICAL ENV NOTE: the DB MUST run on UTC for the e2e suite — `Game.turnStartedAt` is `timestamp without time zone`; tests back-date it with raw `now() - interval` which stores DB-local wall-clock while Prisma reads UTC (the sandbox defaulted to Africa/Lagos → 1h skew → ring timeout test false-failed; `ALTER DATABASE sms SET timezone='UTC'` fixed it). Also FIXED 2 pre-existing game e2e assertion bugs (game.service + race): a winner's cracking guess == the secret and legitimately appears in their own/public guess log, so `not.toContain(secret)` over the whole view was wrong — now assert the UN-cracked secret never leaks + stored secret/target column cleared. These DB suites `describe.skip` without TEST_DATABASE_URL+TEST_ADMIN_URL, so they'd NEVER actually run before.

**Real-time transport — turn warning (2026-06-26):** added the spec §4 "warning
at 15 seconds remaining" to the standalone duel transport (`apps/game-server`):
new `turn_warning` ServerMessage (`{playerId, remainingMs}`, advisory only — no
authority), a `turnWarningMs` option (default 15_000), and a `turnWarnTimers` map
armed alongside the turn timer in `refreshTurnTimer` (fires at `turnMs -
turnWarningMs`, skipped when warning≥turn), cleared via a shared `clearTurnTimers`
in shutdown/finishUp/turn-refresh. 2 new fake-timer tests; game-server 11/11 green,
tsc clean. `server.ts` shell forwards it unchanged. NOTE: Ring/Race/Ultimate still
have NO live socket transport — they're REST-polled web UIs over DB cores.

**Pure `Ring` engine extracted (2026-06-26):** `packages/game-engine/src/ring.ts`
exports `Ring` (+ `RingError`, `RingView`/`RingPlayerView`/`RingGuessView`/
`InheritedHistoryView`/`RingResult`/`RingStatus`/`RingOutcome`), mirroring `Duel`'s
conventions: injected time (no wall clock; timers stay in the transport), no I/O,
typed `code` errors, redacted `viewFor(viewerId)`. Ports the proven logic from
`apps/api/src/game/ring.service.ts`: join/start(min 3)/submitSecret→activate (ring
ordered by join, P0 starts, each targets next), guess (crack → eliminate → ring
re-close where the cracker inherits victim's target → advance to your target),
graduated `timeoutTurn` (skip ×2 → forfeit on 3rd, misses reset on a guess),
voluntary `forfeit`, moderator `abandon` (no winner), reverse-order ranks,
`results()`. SECURITY: secrets NEVER serialized (ring never reveals them, unlike
Duel) and cleared on finish/abandon; §4 inherited history shown ONLY to the
eliminator (scoped by `eliminatedById`). Exported from engine index. 16 new unit
tests (`ring.spec.ts`); game-engine now **97/97**, build clean, full monorepo
typecheck **11/11**. Test gotcha (same as the documented duel one): a winning
guess VALUE == the cracked secret and legitimately appears in the cracker's own
history — assert an UN-cracked secret never leaks + no `"secret"` key, NOT
`not.toContain(secret)` over the whole view.

The durable `RingService` (apps/api) was NOT refactored onto the engine (it's
verified/committed; the engine is in-memory, the service interleaves persistence)
— left as-is.

**Ring WebSocket transport BUILT (2026-06-26):** `apps/game-server` now serves BOTH
modes, routed by PATH — `/ring` → ring, anything else (default) → duel (back-compat).
- `ring-protocol.ts` — `RingClientMessage` (create/join/start/secret/guess/forfeit)
  + `RingServerMessage` (joined/state/scored/turn_warning/over/error).
- `ring-service.ts` — `RingService`, the transport-agnostic orchestration mirroring
  `GameService` (connection = id + send callback, unit-testable w/o sockets). Drives
  the pure `Ring`; live rings in a process-local `Map` (step-2 in-memory). Owns the
  wall-clock concerns: per-turn timeout → `ring.timeoutTurn()` (graduated), the
  15s `turn_warning`, disconnect→`forfeit` grace, guess rate-limit. Creator =
  first player to join (`ring.viewFor().players[0].id`); only they may `start`.
  Per-viewer redacted broadcast (`ring.viewFor(conn.playerId)`) so the §4 inherited
  history reaches only the eliminator. TS gotcha: after a mutating engine call
  (`forfeit`/`timeoutTurn`) re-widen the narrowed status with `as RingStatus`
  before `=== "finished"` (same pattern as the duel's onTurnTimeout).
- `server.ts` — refactored: builds both services, routes on `request.url` (strips
  query + trailing slash), exposes `ringService`, forwards new `turnWarningMs` +
  ring engine bounds (`ringMinPlayers`/`ringMaxPlayers`/`ringMaxConsecutiveMisses`).
  NOTE: this added `turnWarningMs` to `GameServerOptions` (was missing — the duel
  warning wasn't reachable via createGameServer before).
- Tests: `ring-service.spec.ts` (9 — full flow, inherited-history scoping, secret
  non-leak, creator-only start, turn enforcement, rate-limit, turn warning,
  graduated timeout, disconnect forfeit) + a real-socket `/ring` routing test in
  `server.spec.ts`. game-server **21/21**, tsc clean, full monorepo typecheck 11/11.

Real-time gap now CLOSED for duel + ring. Still no socket transport for Race /
League-match / Ultimate (Race/Ultimate are parallel not turn-based; they'd need
their own engine cores extracted like Ring was, or stay REST-polled).

**Pure `Race` engine extracted (2026-06-26):** `packages/game-engine/src/race.ts`
exports `Race` (+ `RaceError`, `RaceView`/`RacePlayerView`/`RaceFinisherView`/
`RaceGuessRecord`/`RaceFinishRecord`/`RaceResult`/`RaceStatus`). Mirrors Duel/Ring
conventions (injected time, no I/O, typed errors, redacted `viewFor`). Ports
`apps/api/src/game/race.service.ts`: ONE shared `target` (server-only, validated
or `generateSecret`-generated, NEVER serialized, cleared on finish), lobby/join/
start(≥1, sets startedAt), parallel `guess` (score vs shared target, record,
on crack `recordFinish`), finish-order ranking (`finishedSoFar+1` — NOT fewest-
guesses; that's tournament-only), top-3 OR all-cracked ends it, host `end()` keeps
finishers, `setConnected` (disconnect does NOT forfeit — racing is parallel),
`results()`. KEY DISTINCTION: a single race ranks by FINISH ORDER; the cross-class
tournament's `computeRaceStandings` (fewest guesses → fastest elapsed) layers
ABOVE this in the api service — the engine just emits per-finisher
{rank,guessCount,elapsedMs} = the `RaceFinish` shape that ranking consumes.
Rate-limiting is a TRANSPORT concern (not in the pure core), like turn timers.
13 new unit tests (`race.spec.ts`); game-engine now **110/110**, build clean,
full monorepo typecheck **11/11**. (Bash `grep` was returning STALE/empty results
this session — the Read tool is authoritative; verify file contents with Read.)

**Race WebSocket transport BUILT (2026-06-26):** `apps/game-server` now serves
THREE modes, routed by PATH — `/ring` → ring, `/race` → race, else (default) → duel.
- `race-protocol.ts` — `RaceClientMessage` (create/join/start/end/guess) +
  `RaceServerMessage` (joined/state/scored/over/error). NO turn_warning (no turns).
- `race-service.ts` — `RaceService`, transport-agnostic orchestration. Drives the
  pure `Race`; live races in a process-local Map. SIMPLER than ring: NO turn
  timers/warnings; `shutdown()` is a no-op; disconnect only `setConnected(false)`
  (NO forfeit — parallel). Owns per-racer guess rate-limit. Host = creator, tracked
  in a `hosts` Map<raceId,playerId> (NOT derivable from RaceView — it has only a
  finishers leaderboard, no roster, unlike RingView.players[0]); only the host may
  start/end. CSPRNG target via `randomInt`; added an `rng?` option (default CSPRNG)
  so tests inject `()=>0` and crack a computed `generateSecret(4,()=>0)` target.
- `server.ts` — routes on exact path (`/ring`,`/race`,else); exposes `raceService`;
  new opts `raceWinners`/`raceRng`.
- Tests: `race-service.spec.ts` (7 — full crack→ranked-over, own-guess-only
  redaction + target never serialized, host-only start/end, no-seat/not-active
  guards, rate-limit, disconnect-no-forfeit, host-end-empty) + a real-socket
  `/race` routing test in `server.spec.ts`. game-server **29/29**, tsc clean,
  full monorepo typecheck 11/11.

Real-time transports built: DUEL + RING + RACE. League-match is just a duel.

**Pure `Arena` engine extracted (2026-06-26):** `packages/game-engine/src/arena.ts`
exports `Arena` (+ `ArenaError`, `ArenaView`/`ArenaEntryView`/`ArenaStandingView`/
`ArenaResult`/`ArenaStatus`/`ParticipantStatus`). The GOVERNANCE-FREE, PII-FREE core
of the cross-school Ultimate (spec §7): rolling solo entry by HANDLE; each
participant gets their OWN per-entry target (server-only, never serialized);
`enter` reserves a seat (status "ready"), `begin` starts that player's clock (after
the transport's §10 15s get-ready countdown — separated so own-start elapsed is
measured from the real start, NOT the lobby), `guess` cracks their own target →
status "finished" + own-start elapsedMs. `standings()`/`results()` rank finishers
via `computeRaceStandings` (fewest guesses → fastest elapsed), reusing
`isValidHandle` from competition.ts for handle validation (3-24 chars, dup handle
rejected case-insensitively). Knows only opaque ids + handles + secrets + scores —
exactly what spec §7 lets cross the tenant boundary; the consent/enrollment/bridge
stays in `apps/api/src/game/ultimate.service.ts`. 8 unit tests (`arena.spec.ts`);
game-engine now **118/118**, build clean, full monorepo typecheck **11/11**. The
api `ultimate.service.ts` compiles unchanged.

Engine cores extracted: Duel, Ring, Race, Arena (+ pure competition/scoring).

**Arena WebSocket transport BUILT (2026-06-26):** `apps/game-server` now serves
FOUR modes, routed by PATH — `/ring`, `/race`, `/arena`, else (default) → duel.
- `arena-protocol.ts` — `ArenaClientMessage` (create/enter/guess/close) +
  `ArenaServerMessage` (created/entered/countdown/state/scored/over/error).
- `arena-service.ts` — `ArenaService`. ADMIN connection `create`s (not a player);
  players `enter` by handle. UNIQUE: `enter` does NOT start the clock — sends a
  `countdown {remainingMs: getReadyMs}` (default 15s, §10) + arms a per-participant
  timer that on fire calls `arena.begin()` (own-start elapsed from the real start,
  NOT the lobby); guessing before that → engine `NOT_STARTED`. Parallel like race
  (no turns; disconnect only clears the connection + that player's countdown timer,
  NO forfeit); per-player guess rate-limit; admin-only `close` → broadcast + `over`
  {results}. `rng?` option (default CSPRNG) so tests seed `()=>0`. `shutdown()`
  clears countdown timers.
- `server.ts` — routes `/arena`; exposes `arenaService`; opts `arenaGetReadyMs`/
  `arenaRng`.
- Tests: `arena-service.spec.ts` (7, fake-timers — full countdown→crack→close→over,
  §5 ranking, handle validation, admin-only close, target never serialized,
  rate-limit, disconnect clears timer) + a real-socket `/arena` routing test in
  `server.spec.ts`. game-server **37/37**, tsc clean, full monorepo typecheck 11/11.

**ALL game real-time transports BUILT** (duel/ring/race/arena); League-match = a
duel. Engine cores: Duel, Ring, Race, Arena.

**Handshake JWT auth BUILT (2026-06-26, spec §11 step 3 — auth half):** the
NestJS-WS-gateway route is BLOCKED in-sandbox (no `@nestjs/websockets`/`ws` in
apps/api; isolated node_modules + no network), so the completable slice was adding
auth to the STANDALONE game-server instead.
- `apps/game-server/src/auth.ts` — `verifyJwt(token, secret, now?)` → `GamePrincipal
  {userId, schoolId, roles, name}`. HAND-ROLLED HS256 on `node:crypto` (zero new
  deps), mirroring `apps/api/src/auth/jwt.ts` claims (userId|sub, school_id|schoolId,
  roles, name). HS256 PINNED (rejects none/HS512), constant-time sig compare,
  exp/nbf enforced. `AuthError` on any failure. 7 tests (`auth.spec.ts`).
- `server.ts` — new `authSecret` opt (default `process.env.AUTH_SECRET`). When set,
  the handshake reads `?token=` from `request.url` (now parsed via `new URL`),
  verifies, and on failure sends an UNAUTHORIZED error frame + `socket.close(4401)`
  BEFORE binding to any service (gates ALL 4 modes). Unset ⇒ open dev mode
  (principal undefined). Principal passed to `service.connect(send, principal)`.
- `game-service.ts` (the REFERENCE) — `connect(send, principal?)`; `onCreate`/
  `onJoin` use `principal.name` for display (ignoring a spoofed `displayName`
  frame — now optional in protocol.ts) and enforce TENANT ISOLATION via a
  `gameSchool` Map<gameId,schoolId>: cross-school join → `GAME_NOT_FOUND` (404-not-403).
  2 new tests (verified-identity, tenant-isolation). Real-socket auth-gate test in
  `server.spec.ts` (valid token → joined; no token → close 4401).
game-server **47/47**, full monorepo typecheck 11/11, tsc clean.

REMAINING follow-ups (not blockers, incremental): (1) thread the principal into
ring/race/arena identity the same way (they're already handshake-gated, just still
use client display names internally); (2) Postgres persistence of durable RESULTS
at game-end (spec §10) — needs the live games running inside the SMS process or a
results-write API; (3) the full NestJS WS gateway + web client live-socket wiring
(needs deps/network the sandbox lacks). Arena stays deliberately cross-school (no
same-school join gate; schoolId is grouping-only per spec §7) when its turn comes.

Race discovery: added `GET /races` (`RaceService.listRaces` → `RaceSummaryDto[]`, relationship-scoped like getRace: school-wide staff=all, teacher=own classes, student=enrolled+joined; LOBBY/ACTIVE only; target never serialized; has a relationship-scoping e2e case) — the hub lists joinable races. The Button component has NO `asChild` — use `buttonVariants()` on a `<Link>` for link-buttons (existing pattern). Web `tsc --noEmit` clean; the only diagnostic is the Next TS-plugin 71007 "serializable props" warning on client→client function props (editor-only, not a tsc/CI error). Web `lint` (next lint) is NOT configured (prompts interactively) — typecheck is the real web gate. Still uncommitted.
