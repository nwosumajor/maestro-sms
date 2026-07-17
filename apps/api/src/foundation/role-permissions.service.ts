// =============================================================================
// RolePermissionsService — cached role → permission resolution
// =============================================================================
// The Auth.js session cookie no longer carries the user's full permissions
// array (a principal's ~97 permission strings pushed the cookie past nginx's
// 4 KB header buffer and toward the browser's own cookie cap — the 502 class of
// failure). Bearers now carry ROLES only; this service resolves the permission
// union at the guard, from the same seeded Role/RolePermission/Permission
// tables the login flow reads.
//
// Posture:
//   - The tables are GLOBAL (RLS-exempt, app role SELECT) — a direct prisma
//     read, no tenant GUC needed.
//   - One cached map for the whole platform (role → permissions is platform
//     configuration; per-USER role assignment stays per-request in the token).
//     60s TTL mirrors the entitlement cache; a re-seed lands within a minute.
//   - DB outage falls back to the shared static map in @sms/types (the seed
//     writes the DB FROM that map, so the fallback equals the steady state).
// SECURITY: roles come only from the verified JWT; this service just expands
// them. JIT elevation stays additive at the guard exactly as before.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { prisma } from "@sms/db";
import { ROLE_PERMISSIONS } from "@sms/types";

const CACHE_TTL_MS = 60_000;

@Injectable()
export class RolePermissionsService {
  private readonly logger = new Logger("RolePermissions");
  private cache: Map<string, string[]> | null = null;
  private cachedAt = 0;
  private loading: Promise<Map<string, string[]>> | null = null;

  /** Union of every permission granted by `roles` (order-stable, deduped). */
  async forRoles(roles: readonly string[]): Promise<string[]> {
    if (roles.length === 0) return [];
    const map = await this.roleMap();
    const out = new Set<string>();
    for (const r of roles) for (const p of map.get(r) ?? []) out.add(p);
    return [...out];
  }

  private async roleMap(): Promise<Map<string, string[]>> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < CACHE_TTL_MS) return this.cache;
    // Single-flight: concurrent cold requests share one DB load.
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async load(): Promise<Map<string, string[]>> {
    try {
      const rows = await prisma.role.findMany({
        select: { name: true, permissions: { select: { permission: { select: { key: true } } } } },
      });
      const map = new Map<string, string[]>(
        rows.map((r) => [r.name, r.permissions.map((rp) => rp.permission.key)]),
      );
      this.cache = map;
      this.cachedAt = Date.now();
      return map;
    } catch (err) {
      this.logger.warn(`role map DB load failed — using the @sms/types static map: ${String(err)}`);
      // Stale cache beats static map (it reflected the DB at some point).
      if (this.cache) return this.cache;
      const map = new Map<string, string[]>(
        Object.entries(ROLE_PERMISSIONS).map(([k, v]) => [k, [...v]]),
      );
      return map;
    }
  }
}
