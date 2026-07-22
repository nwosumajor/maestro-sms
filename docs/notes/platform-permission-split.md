# Platform permission split + manager_admin

> platform.operate split into granular risk-classified permissions + manager_admin role so the owner can employ staff for platform duties while keeping absolute control. Merged 78bdfa6, 2026-07-15.

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

The owner (super_admin) couldn't delegate: `platform.operate` was ONE permission gating
all 25 operator endpoints, so employing staff meant handing over impersonation, pricing
and cross-tenant student PII. Split by **RISK OF ESCALATION** ("could a holder turn this
into full control?"), not by feature area.

**DELEGABLE → `manager_admin`** (seeded in the platform org; demo `manager@sms.platform`):
`platform.tenants.read`, `platform.tenants.write`, `platform.onboarding.review`,
`platform.audit.read`, `platform.user.read`, `platform.user.unlock` (+ notification.read).

**OWNER-ONLY → `super_admin`**: `platform.impersonate`, `platform.user.credentials`,
`platform.tenants.status`, `platform.subscription.manage`, `platform.pricing.manage`,
`platform.student.read`.

**Non-obvious things that drove the design — remember these:**
1. **`platform.operate` was doing DOUBLE DUTY** — gating endpoints AND acting as the
   "I am the owner" marker (`directory.service.ts` cross-school search, dashboard routing,
   AppShell framing). A naive split would have silently given staff cross-tenant directory
   search. It's now RETAINED but demoted to owner-identity ONLY — it gates no endpoint.
2. **A temp password IS impersonation.** `POST .../users/:id/reset-password` returns the
   password and `.../mfa/reset` disables MFA → a manager could just log in as any
   school_admin. That's why the user-admin cluster is split by risk (`user.read`/`user.unlock`
   delegable; `user.credentials` owner-only) rather than kept as one feature group.
3. **NON_ELEVATABLE spreads `ALL_PLATFORM_PERMISSIONS`** from operator.ts, so any NEW
   platform permission is non-elevatable the moment it's defined. Forgetting one would let
   manager_admin JIT-elevate into the owner set and make the whole split theatre.
4. manager_admin deliberately lacks `rbac.manage` (would let it grant itself roles).

Files: `packages/types/src/permissions/operator.ts` (ALL_PLATFORM_PERMISSIONS +
DELEGABLE_PLATFORM_PERMISSIONS), `packages/types/src/elevation.ts`, `packages/db/prisma/seed.ts`
(ROLE_PERMS — roles are created from its keys, so a new role needs no other registration),
`apps/api/src/operator/operator.controller.ts`, web nav/page guards + per-control gating.

Invariant suite: `apps/api/test/operator/platform-permission-split.spec.ts` (17 tests) —
all platform perms non-elevatable, delegable∩owner-only=∅, nothing unclassified, and the
GUARD proven to 403 manager_admin per owner-only perm. Verified vs live DB after re-seed:
manager_admin = exactly 6 delegable + notification.read, ZERO owner-only; super_admin = all 13.

**GOTCHA: permissions ride the JWT from login** — after deploying a seed/permission change,
existing sessions keep the OLD claims. super_admin must re-login to get the granular perms.
To add/remove a manager duty later = a one-line seed change (+ re-login), not new code.
See [superadmin-coherence-audit](superadmin-coherence-audit.md) and [platform-owner-org-model](platform-owner-org-model.md).
