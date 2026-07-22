# super_admin coherence audit

> super_admin surface audit + fixes — platform org excluded from ALL public slug resolvers; privileged client needed locally for operator console; impersonation verified into new HR features

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**super_admin coherence audit (2026-07-12, user-requested)** — verified + fixed, UNCOMMITTED.

Model confirmed coherent: super_admin holds ONLY platform perms (platform.operate, billing.dunning.run, security.audit.read, directory.search, game.ultimate.admin/leaderboard, scholarship.admin/read) — direct school-data access correctly 403s; school review happens via **audited step-up impersonation** (`POST /operator/impersonate {schoolId, userId}` → scoped token as that user; the impersonated token holds NO platform perms — /operator 403).

**Fix applied**: public slug resolvers now consistently exclude `isPlatform` orgs — patched 4 spots (admissions submit [pre-existing hole], careers publicOpenings + publicApply, biometric ingestion) to `{slug, status:"ACTIVE", isPlatform:false}`, matching /public/schools + directory + operator. Verified: /public/careers/sms-platform, admissions-to-platform, biometric-to-platform all 404; demo still works.

**Local env gap fixed**: the host-run API had no `DATABASE_MIGRATE_URL`, so /operator/analytics + /operator/audit (privileged cross-tenant reads) returned **503**. Added the postgres superuser DSN to the scratchpad `api.clean.env` — operator console fully functional locally now. REMEMBER: any future host-run API restart needs DATABASE_MIGRATE_URL set or operator analytics/audit + provisioning + sweeps are disabled.

Verified live as owner@sms.platform: tenants page (platform org excluded), analytics 200, platform audit 200, pricing 200, subscription GET (demo=ENTERPRISE/ACTIVE), impersonation → all new HR surfaces work (14 employees, attendance register, analytics v2, org chart, payroll runs, loans).
