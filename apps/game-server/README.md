# @sms/game-server

Standalone **server-authoritative 2-player Dead & Wounded** game over WebSockets.
Build step 2 of the platform spec (`DEAD_AND_WOUNDED_PLATFORM_SPEC.md` §11; §9
real-time + server-authority). No SMS dependency yet — step 3 swaps in SMS auth,
`school_id`, and Postgres persistence.

## Design

- All game authority lives in `@sms/game-engine` (`Duel`). This app is the
  transport.
- **`GameService`** (`src/game-service.ts`) — transport-agnostic orchestration: a
  connection is just an id + a `send` callback, so it is fully unit-testable
  without sockets. It maps the wire protocol to the engine, broadcasts the
  engine's **redacted** views, and owns the wall-clock concerns the pure core
  doesn't: per-turn timeout (graduated skip → forfeit), disconnect-forfeit grace,
  and guess rate-limiting.
- **`server.ts`** — a thin `ws` shell: one socket = one connection; it sends only
  what `GameService` produces.
- **`protocol.ts`** — the JSON message shapes.

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
