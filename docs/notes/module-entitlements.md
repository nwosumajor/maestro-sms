# Module entitlements

> Subscription/module-entitlement layer — super_admin toggles modules per school by plan tier

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Built (2026-06-24) a per-school **subscription / module-entitlement** layer so super_admin can enable/disable product modules to fit a school's budget — the user explicitly asked for this; it did NOT exist before (access was role→permission only, identical for every tenant). Decisions chosen by the user: **super_admin-only** control (schools can't self-upgrade) + **named plan tiers (BASIC/STANDARD/ENTERPRISE) + per-school overrides**.

Architecture (orthogonal SECOND gate above RBAC):
- Source of truth `packages/types/src/modules.ts`: `MODULES` keys, `MODULE_CATALOG` (labels for the UI), `PLANS`, `PLAN_MODULES` (tier→module bundle), `ModuleOverrides {enabled?,disabled?}`, pure `resolveModules(plan,overrides)`, `DEFAULT_PLAN=ENTERPRISE`, `isModuleKey`/`isPlan`. DTOs in `dto/subscription.ts`. Both exported from index.
- DB: `SchoolSubscription` model (foundation.prisma) — tenant-scoped, `plan` + `overrides` Json, unique schoolId. Migration `20260629000000_subscription`, RLS `22_subscription_rls.sql` (standard tenant policies + grant SELECT/INSERT/UPDATE to major_user, no DELETE; registered in docker-entrypoint sentinel `school_subscription_update`). NO row ⇒ ENTERPRISE default, so the layer only RESTRICTS (never breaks existing tenants).
- Enforcement: `@RequireModule(MODULES.X)` decorator (`apps/api/src/auth/require-module.decorator.ts`) on ~24 feature controllers (class-level). The existing `PermissionGuard` was EXTENDED (not a new guard) — after auth, reads MODULE_KEY metadata and returns **404** (never-leak) if the school's effective modules exclude it, via `ModuleEntitlementService` (`apps/api/src/foundation/module-entitlement.service.ts`, 30s cache, invalidated on write). Untagged/always-on: foundation/auth, security, privacy, notifications, admin, operator; public `/apply` bypasses via @Public.
- super_admin surface: `GET/PUT /operator/tenants/:schoolId/subscription` (OperatorService, platform.operate, audited, cache-invalidating). `listTenants` now returns `plan`+`moduleCount` (TenantDto extended). Web `/operator` rebuilt as cards with `SubscriptionManager` (components/operator/, client: tier select + per-module checkboxes → PUT). AppShell is now ASYNC, reads `modules` from the session and hides nav items whose `module:` isn't enabled; modules flow login→JWT→session (auth.service `/auth/login` returns `modules`; web auth.ts + next-auth.d.ts threaded).

To add a module: add a key to `@sms/types` MODULES + a `@RequireModule` on its controller + a nav `module:` tag + add to PLAN_MODULES tiers.

Verified against the live Postgres (see [dead-and-wounded-game](dead-and-wounded-game.md) for the in-sandbox UTC cluster setup): migration+RLS applied, full api suite 24 suites/171 tests green (incl. new `operator/subscription.e2e-spec.ts` = resolution/tiers/overrides/cross-tenant RLS, and `auth/module-guard.spec.ts` = guard 404s on disabled module), typecheck 11/11, web build compiles `/operator`. Still uncommitted.

UPDATE: plan tiers are now **STANDARD < PREMIUM < ULTIMATE < ENTERPRISE** (4 cumulative tiers; BASIC removed). All 25 entitlement modules distributed: STANDARD=8 (lms,gradebook,attendance,timetable,messaging,calendar,sis,library), PREMIUM +10 (fees,documents,workflow,analytics,integrity,task,poll,discussion,form,certificate)=18, ULTIMATE +5 (admissions,hostel,transport,discipline,alumni)=23, ENTERPRISE +2 (hr,games)=25. The 10 expansion-module controllers now carry @RequireModule; their nav items carry `module:` tags. `FALLBACK_PLAN=STANDARD` (delinquency floor, replaced BASIC); PLAN_PRICING ₦200/350/500/750 per seat/month. Data migration `20260723000000_plan_tiers_rename` maps any BASIC→STANDARD. Live-verified module-count ladder + /hostels 404 on STANDARD. See [enterprise-feature-expansion](enterprise-feature-expansion.md).
