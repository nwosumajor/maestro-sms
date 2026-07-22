# Full-stack run verified

> The whole SMS stack was brought up live (DB+Redis+API+Web+game-server) and the full test suite + build passed against real infra on 2026-06-26

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

On 2026-06-26 the sandbox network was enabled (user-authorized) and the COMPLETE
stack was run end-to-end, not just typechecked. Reproducible setup:

- **Infra**: `docker run` Postgres 16-alpine on host port **5544** with
  `-c timezone=UTC` (the e2e suite REQUIRES UTC — see [dead-and-wounded-game](dead-and-wounded-game.md)),
  Redis 7-alpine on **6399**. App role `major_user`/`majorpw` created via the same
  DO-block as `infrastructure/postgres/init/01-app-role.sh`.
- **DB setup** (from `packages/db`): `DATABASE_URL=$SUPER prisma migrate deploy` →
  `DATABASE_MIGRATE_URL=$SUPER pnpm rls` (all 23 RLS files, ON_ERROR_STOP, clean) →
  `prisma db seed` (school St. Andrews Academy + demo users). SUPER =
  `postgresql://postgres:postgres@localhost:5544/sms`, APP = same with
  `major_user:majorpw`.
- **Tests**: with `TEST_DATABASE_URL=$APP TEST_ADMIN_URL=$SUPER REDIS_HOST=localhost
  REDIS_PORT=6399 AUTH_SECRET=… DATA_ENCRYPTION_KEY=…`, the FULL api suite passed for
  the FIRST time in-sandbox: **26 suites / 182 tests** (incl. every previously
  DB-gated game e2e — game/competition/race/ring/game-settings/ultimate — and the
  RLS cross-tenant suite). Whole monorepo: `pnpm test` 8/8 turbo, `pnpm build` 7/7
  (web Next.js prod build compiles all routes incl. the game screens).
- **Live**: API (`node apps/api/dist/main.js`) :3001 `/health`→200, all routes mapped,
  BullMQ/Redis connected, retention scheduler armed. Web (`next start`) :3000
  `/login`→200. Game-server :8080 (duel `/`, ring `/ring`, race `/race`, arena `/arena`).
  Verified auth E2E by minting an HS256 JWT (same AUTH_SECRET) from `/auth/login`
  claims: no-token→401, tampered→401, permission-gated `/users`→403 (teacher lacks
  perm), `/games/open`→200 `[]`.

**Bug FOUND & FIXED this run:** my handshake-auth gate made `server.ts` read
`process.env.AUTH_SECRET` as a fallback; the game-server `server.spec.ts` open-mode
real-socket routing tests (duel/ring/race/arena) connect WITHOUT a token, so they
4401-failed once AUTH_SECRET was in the env (4 failures under `pnpm test`, but
passed standalone). FIX: those four `createGameServer(...)` calls now pass
`authSecret: ""` to force open mode regardless of ambient env. game-server back to
47/47. Lesson: env-dependent defaults need explicit override in tests.

NOTE: `next start` warns because web uses `output: standalone` — true prod runs
`node apps/web/.next/standalone/server.js`. Everything still UNCOMMITTED (user keeps
deferring the commit). `/auth/login` returns principal CLAIMS, not a token —
Auth.js in the web layer signs the JWT; to call the API directly you mint the HS256
token yourself from those claims.
