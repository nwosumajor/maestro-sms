# MAESTRO owner relocation

> Platform org renamed MAESTRO-SMS; owner relocated from St. Andrews into it (seed now self-heals); header eyebrow shows 'Super Admin Console' for platform.operate; verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

User asked why the super admin console read "St. Andrews Academy · School
Console". Root cause: this DB predates the platform-org model — the seed's
`mkUser`/`userRole` upserts had `update: {}` so re-seeding NEVER relocated the
existing owner@sms.platform row (schoolId stayed the demo school; the "SMS
Platform" org existed but was memberless). The session schoolName then showed
St. Andrews, plus a hardcoded "School Console" eyebrow.

Fixes:
- Seed: platform org upsert now names it **MAESTRO-SMS** (the user's platform
  name) on create AND update; explicit `prisma.user.update` relocates the owner
  to the platform org on every seed; userRole upsert update branch now corrects
  `schoolId` (general drift healer). Ran the seed → relocated.
- Owner's notifications/deliveries migrated to the platform org via psql (RLS
  keys on schoolId; his inbox would otherwise vanish). His old audit rows stay
  in St. Andrews (append-only history; platform audit console reads privileged).
- AppShell eyebrow: `isPlatformOwner ? "Super Admin Console" : "School Console"`.
- NOTE: owner must RE-LOGIN for the new schoolName claim (JWT-borne).
- Earlier memories' "owner's schoolId IS St. Andrews in this DB" caveats are now
  OBSOLETE — owner lives in MAESTRO-SMS (isPlatform). PublicService's
  notifyPlatformOwners platform-org path now hits on the FIRST branch.
Verified: login claims schoolName=MAESTRO-SMS; header MAESTRO-SMS + Super Admin
Console; remaining "St. Andrews" on owner dashboard is legit chart data
(tenants-by-plan). Smoke owner+admin green. UNCOMMITTED.
