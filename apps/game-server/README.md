# @sms/game-server

Standalone **server-authoritative Dead & Wounded** game server over WebSockets:
the **2-player duel** (build step 2), the **Class Race** (step 5), the **N-player
Elimination Ring** (step 6), and the **Ultimate cross-school arena** (step 8) of
the platform spec (`DEAD_AND_WOUNDED_PLATFORM_SPEC.md` §11; §9 real-time +
server-authority).

Connections are routed by **path**: `/ring` plays the Elimination Ring, `/race`
the Class Race, `/arena` the Ultimate arena; anything else (the default) plays the
2-player duel.

## Handshake auth (spec §11 step 3 — the auth half)

When `AUTH_SECRET` is set (the same shared Auth.js secret the SMS API verifies),
the WebSocket handshake MUST carry a valid HS256 JWT as `?token=…`; an
unauthenticated socket is closed with code **4401** before it reaches any service.
Verification is hand-rolled on `node:crypto` (`src/auth.ts`) — zero extra deps,
HS256 pinned, signature compared in constant time, `exp`/`nbf` enforced — and
mirrors `apps/api/src/auth/jwt.ts`'s claims (`userId|sub`, `school_id|schoolId`,
`roles`, `name`). The verified **principal becomes the identity**: the duel uses
the token's `name` (a spoofed `displayName` frame is ignored) and enforces
**tenant isolation** — you may only join a game created in your own `school_id`
(404-not-403). With NO secret the server runs in open dev mode (display-name
identity), mirroring the SMS "gracefully disabled when the secret is unset"
pattern. Ring/race/arena are gated by the same handshake; threading the principal
into their identity model is the remaining follow-up. Postgres persistence of
durable results (spec §10) is still to come.

## Design

- All game authority lives in `@sms/game-engine` (`Duel`, `Ring`). This app is the
  transport only.
- **`GameService`** (`src/game-service.ts`) — transport-agnostic orchestration of
  the duel: a connection is just an id + a `send` callback, so it is fully unit-
  testable without sockets. It maps the wire protocol to the engine, broadcasts
  the engine's **redacted** views, and owns the wall-clock concerns the pure core
  doesn't: per-turn timeout (graduated skip → forfeit), the 15s-remaining turn
  warning (spec §4 — broadcast as a `turn_warning` frame, advisory only),
  disconnect-forfeit grace, and guess rate-limiting.
- **`RingService`** (`src/ring-service.ts`) — the same orchestration shape for the
  Elimination Ring (`Ring`): lobby/`start` (creator-only), secrets, turn-order
  play, the crack → eliminate → **ring re-close**, the §4 **inherited-history**
  reward (revealed only to whoever cracked the player, via per-viewer redacted
  views), plus the same turn-timeout / turn-warning / disconnect-forfeit / rate-
  limit concerns. Live ring state is a process-local map (step-2 in-memory; the
  Postgres-persisted equivalent is `apps/api/src/game/ring.service.ts`).
- **`RaceService`** (`src/race-service.ts`) — orchestration for the Class Race
  (`Race`): one shared (CSPRNG-generated, never-serialized) target, host-only
  `start`/`end`, parallel (turn-less) play, finish-order ranking, top-3 (or all-
  cracked) ends it. Simpler than the ring — NO turn timers/warnings, and a
  disconnect does NOT forfeit (racing is parallel; others keep going). The one
  wall-clock concern it owns is per-racer guess rate-limiting. Per-viewer redacted
  views expose only the racer's own guesses + a finishers-only leaderboard.
- **`ArenaService`** (`src/arena-service.ts`) — orchestration for the Ultimate
  cross-school arena (`Arena`): an ADMIN `create`s the arena (admins don't play),
  players `enter` by HANDLE and get their OWN per-entry target. Unique to this
  mode, `enter` does NOT start the clock — the transport sends a `countdown` and
  only when the §10 **15s get-ready** elapses does it call `arena.begin()` (so
  own-start elapsed is measured from the real start). Parallel like the race (no
  turns, disconnect ≠ forfeit, per-player rate-limit); finishers rank by the §5
  metric; the admin `close`s to publish final standings. PII-free: only handles +
  scores cross the wire.
- **`server.ts`** — a thin `ws` shell: one socket = one connection, routed to the
  duel / ring / race / arena service by path; it sends only what the service
  produces.
- **`protocol.ts` / `ring-protocol.ts` / `race-protocol.ts` / `arena-protocol.ts`**
  — the JSON message shapes per mode.

## Server authority (spec §9, non-negotiable)

- Secrets are held server-side only; **no server→client frame ever carries a live
  secret** (proven by tests on both the service and the real socket path). Both
  secrets are revealed only once the game is finished.
- Turn order, scoring, win/forfeit/timeout are decided on the server. Clients are
  display-only and cannot guess out of turn or score their own guess.

## Run

```
PORT=8080 pnpm --filter @sms/game-server start   # after `pnpm --filter @sms/game-server build`
```

## Test

```
pnpm --filter @sms/game-server test
```

## Note on types

`@types/ws` is not vendored; `src/ws.d.ts` declares the small `ws` surface used so
the transport typechecks offline. Replace with `@types/ws` when convenient.
