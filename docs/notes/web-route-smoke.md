# Web route smoke

> Route smoke test that logs in as every role and asserts every SSR page renders (catches the 500s jest can't see). Run: pnpm --filter @sms/web smoke:routes

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

`apps/web/scripts/route-smoke.mjs` (npm script `smoke:routes`). Logs in as each
demo role via the REAL Auth.js credentials flow, auto-discovers every
`app/(app)/**/page.tsx` route, fills dynamic segments (`[id]`/`[assessmentId]`/
`[userId]`) with real ids resolved through the BFF, GETs each, and FAILS (exit 1)
on any 500 or error-boundary render. Catches the SSR-only bugs the API jest suite
can't — the class that hit twice on 2026-07-04: operator/audit calling `.map` on
a now-paginated `/operator/tenants` object, and `/students/[id]` crashing because
`apiGet` did `res.json()` on a legit empty-body 200 (student with no medical
record). Both fixed; `apiGet` now returns null on an empty body.

Gotchas: needs BOTH the web (:3000) and api (:3001) up against the seeded demo DB.
The API rate-limits POST /auth/login (10/min per IP), so the script PACES logins
(token bucket, 9/window) + retries — testing all 17 roles takes ~2 min (one ~60s
wait). Env: `WEB_URL`, `SMOKE_PASSWORD`, `SMOKE_ROLES` (comma list; default all 17
demo accounts). Rebuild+restart `next start` before running (a stale server serves
old chunks — see [july-2026-hardening-sweep](july-2026-hardening-sweep.md) pkill note). Verified with a
throwaway throwing page (flagged 500, exit 1) then removed. NOT yet wired into CI
(would need web+api+db in the workflow). All UNCOMMITTED with the rest of the
[academic-grading-parent-feature](academic-grading-parent-feature.md) work.
