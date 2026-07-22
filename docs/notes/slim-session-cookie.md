# Slim session cookie

> Session cookie carries ROLES only — permissions derived server-side from the shared @sms/types role-map (single source of truth with the seed); 3.7KB→1.2KB, 502-class risk eliminated (2026-07-17)

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

Root fix for the nginx-502 class (commit d95e05a, live-verified): the Auth.js
cookie no longer stores the permissions array (a principal = 97 perms ≈ 3.7KB
cookie, past nginx's 4KB default header buffer and near the browser's ~4KB
cookie cap). Cookie now 1.2KB.

**Architecture (don't regress):**
- `ROLE_PERMISSIONS` + `permissionsForRoles()` live in
  packages/types/src/permissions/role-map.ts — THE single source of truth.
  packages/db/prisma/seed.ts IMPORTS it (@sms/db now depends on @sms/types;
  no cycle — types depends only on zod). Edit the matrix THERE, then re-seed.
- Bearers (apiToken.ts, auth.ts refresh mint, ws-ticket) carry roles ONLY.
  API PermissionGuard + GameSocketGateway expand roles→permissions via
  `RolePermissionsService` (foundation, 60s cache, single-flight, direct
  prisma read of global role tables; fallback stale-cache→static map).
  Back-compat: bearers WITH permissions (operator impersonation tokens) are
  honoured unchanged — the enrichment only fires when the array is empty.
- Web session callback DERIVES session.user.permissions =
  permissionsForRoles(roles) (pure fn — Edge-safe); jwt callback sets
  token.permissions = undefined (scrubs pre-slim cookies at first refresh).
  hasPermission page gating unchanged. `modules` stay in the cookie (small,
  catalog-bounded).
- Side benefit: a re-seeded permission change reaches the API in ≤60s, not at
  next login.

**Guardrail:** route-smoke.mjs FAILS if any role's session cookie > 3072 bytes
(prints the largest; currently 1203 = principal). Runbook Step 6: always smoke
a ROLE-HEAVY login (principal), not just the owner; nginx is LOCAL-ONLY —
prod is CloudFront→ALB→ECS (higher header limits, but the budget still rules).

Related: [scholarship-chain](scholarship-chain.md) (why perms grew), nginx buffer bump 584e70a
(kept as defence-in-depth for local dev).
