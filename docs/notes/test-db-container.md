# Test DB container

> How to run the DB-gated jest suites locally — sms-test-pg container creds/ports and the major_user password alignment

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The DB-gated API test suites run against the `sms-test-pg` docker container
(host port **5434**, superuser `postgres:postgres`, db `sms`; `sms-test-redis`
on **6380**). Schema is built with `prisma db push` (never `migrate deploy` —
the migration ledger doesn't replay from scratch, see CLAUDE.md).

- `TEST_ADMIN_URL=postgresql://postgres:postgres@localhost:5434/sms`
- `TEST_DATABASE_URL` / `DATABASE_URL` = `postgresql://major_user:<APP_DB_PASSWORD from infrastructure/.env>@localhost:5434/sms`
  — on 2026-07-20 the container's `major_user` password was ALTERed to match
  `APP_DB_PASSWORD` in `infrastructure/.env` (it was previously something else
  and auth failed). The container env's `APP_DB_PASSWORD=password` is NOT the
  live role password.
- Containers exit on reboot: `docker start sms-test-pg sms-test-redis` first.
- Full suite: `cd apps/api && npx jest --runInBand` with the env above
  (+ `REDIS_HOST=localhost REDIS_PORT=6380`) — 99 suites / 779 tests, ~25s.
- E2e afterAll cleanups must delete `audit_log` rows before `"user"` rows
  (audit_log_actorId_fkey), in addition to the usual FK child-before-parent
  order. Related: [july-2026-hardening-sweep](july-2026-hardening-sweep.md) (main dev stack on 5433).
