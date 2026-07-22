# Invite links & help manual

> Set-password invite links for provisioned admins (7d HS256, single-use via passwordChangedAt-null gate) + role-aware /help application manual; live-verified 2026-07-13, UNCOMMITTED

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Credential delivery + manual (user-requested):
- **Invite links**: `apps/api/src/auth/invite.ts` — HS256 tokens signed with
  AUTH_SECRET, `purpose:"invite"` (a session JWT can't be replayed here and vice
  versa), 7-day expiry. `POST /public/invite/accept` {token, password} (@Public,
  rate-limited, zod min 8) → `PublicService.acceptInvite`: honoured ONLY while
  `passwordChangedAt IS NULL` → natural single-use, no token table; sets
  passwordHash (hashed OUTSIDE the tx) + passwordChangedAt=now; ONE generic
  error for every failure (no account/token oracle). Web: public `/welcome?token=`
  page (SetPasswordForm → success → /login?school=slug link).
- **Provisioning fix**: user.create now sets `passwordChangedAt: null` (schema
  default is now()! — provisioned admins previously did NOT have the documented
  forced-first-reset; bulk import already set null explicitly). This both forces
  the temp-password reset AND arms the invite. `sendInviteEmail` (best-effort,
  PUBLIC_WEB_URL link) fires from provisionSchool AND createAdmin; the welcome
  notification/email copy now points at the link + Help page; temp password in
  the operator console remains the fallback.
- **/help manual**: role-aware guide page (sections gated by hasPermission:
  basics/everyone, school-admin getting-started 7 steps, teachers daily loop,
  parents+students, billing, super_admin ops) + nav item "help" (no perm,
  NAV_GROUP platform, in PLATFORM_OWNER_NAV). Route count now 70.
- Verified live: provision → "[email-stub] Activate your … account" +
  welcome email; accept 201 → login with chosen password 200 (no forced reset);
  replay → 400; session-token-as-invite → 400 (purpose check); /welcome renders;
  route smoke 70×4 roles green. Test school deleted. UNCOMMITTED.
