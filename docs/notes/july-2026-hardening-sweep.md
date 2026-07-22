# July 2026 hardening sweep

> The big July-2026 review/fix session — revenue+security fixes, redesign, operator pricing, 3 new roles, FEE_SCHEDULE maker-checker, concurrency guards, docs updated; ALL UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

One giant session (2026-07-01→03) of three full reviews + user-driven fixes, all
live-verified. Everything is documented in CLAUDE.md ("July 2026
review-and-hardening sweep") and API.md (371 endpoints) — read those first.
**Nothing from this session is committed yet** — the user was offered a commit
series repeatedly and hasn't said yes.

Key facts NOT obvious from the repo docs:
- **Local dev env to start the API** (UPDATED 2026-07-13 — docker stack moved):
  Postgres is `sms-postgres-1` on host port **5433** (app role password =
  `APP_DB_PASSWORD` in `infrastructure/.env`, NOT majorpw; superuser =
  `POSTGRES_PASSWORD` there), Redis `sms-redis-1` on **6379**. From `apps/api`:
  `set -a; source infrastructure/.env; source apps/web/.env.local; set +a` —
  ORDER MATTERS: infrastructure/.env ALSO defines AUTH_SECRET and the web signs
  with .env.local's, so .env.local must be sourced LAST — then
  `DATABASE_URL=postgresql://major_user:${APP_DB_PASSWORD}@localhost:5433/sms
  DATABASE_MIGRATE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@localhost:5433/sms
  REDIS_HOST=localhost REDIS_PORT=6379 API_PORT=3001 node dist/main.js`.
  `pkill -f "dist/mai[n]"` (char-class!) in a command that NOWHERE ELSE mentions
  dist/main.js, or the shell kills itself. Web = standalone build
  (`node .next/standalone/apps/web/server.js`, copy `.next/static` + `public` in
  first); route smoke accepts `WEB_URL=` override.
- Real tenants exist beyond demo: **British Elshaddi High School** (ENTERPRISE,
  staff ojukwu@/wisdom@britishehs.com, 11+ students incl. Pablo Putt) and
  **Sunrise College** (ENTERPRISE). Demo = St. Andrews (ULTIMATE — NO HR module;
  HR testing needs an ENTERPRISE school or a temporary operator plan flip).
- Screenshots: snap chromium works headless ONLY writing under
  `~/snap/chromium/common/` (user-data-dir + output there).
- The web login flow: mint HS256 bearer from `/auth/login` claims with
  AUTH_SECRET (jsonwebtoken resolves only from apps/api cwd); step-up via
  `POST /security/stepup` with the password.
- [warden-driver-roles](warden-driver-roles.md) extended: head_warden/head_driver/librarian (17 roles).
