// =============================================================================
// ModuleEntitlementService — resolves a school's enabled modules (billing layer)
// =============================================================================
// Reads the tenant-scoped `school_subscription` row and resolves it (tier bundle
// + per-school overrides) into the effective module set. Used by:
//   - PermissionGuard (the @RequireModule gate),
//   - AuthService (so the web session/nav knows what to show),
//   - OperatorService (super_admin reads/writes a school's plan).
//
// The guard hits this on (almost) every request, so resolution is cached per
// school for a short TTL. A school with NO row defaults to ENTERPRISE so the
// layer only ever RESTRICTS — it never breaks a tenant predating subscriptions.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import {
  DEFAULT_PLAN,
  isPlan,
  resolveModules,
  type ModuleKey,
  type ModuleOverrides,
  type Plan,
} from "@sms/types";
import {
  TENANT_DATABASE,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";

const CACHE_TTL_MS = 30_000;

interface Resolved {
  plan: Plan;
  overrides: ModuleOverrides;
  modules: ModuleKey[];
}

@Injectable()
export class ModuleEntitlementService {
  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  private cache = new Map<string, { at: number; value: Resolved }>();

  /** Effective enabled modules for a school (cached). */
  async effectiveModules(schoolId: string): Promise<ModuleKey[]> {
    return (await this.resolve(schoolId)).modules;
  }

  /** Whether a school's plan enables a given module. */
  async isEnabled(schoolId: string, module: ModuleKey): Promise<boolean> {
    return (await this.effectiveModules(schoolId)).includes(module);
  }

  /** Full resolved subscription (for the operator console + login claims). */
  async resolve(schoolId: string): Promise<Resolved> {
    const hit = this.cache.get(schoolId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const row = await this.db.runAsTenant({ schoolId, userId: schoolId }, async (tx: TenantTx) =>
      tx.schoolSubscription.findFirst({ where: { schoolId }, select: { plan: true, overrides: true } }),
    );
    const plan: Plan = row && isPlan(row.plan) ? (row.plan as Plan) : DEFAULT_PLAN;
    const overrides = (row?.overrides ?? {}) as ModuleOverrides;
    const value: Resolved = { plan, overrides, modules: resolveModules(plan, overrides) };
    this.cache.set(schoolId, { at: Date.now(), value });
    return value;
  }

  /** Invalidate the cache for a school (call after an operator writes the row). */
  invalidate(schoolId: string): void {
    this.cache.delete(schoolId);
  }
}

export const MODULE_ENTITLEMENT_SERVICE = "MODULE_ENTITLEMENT_SERVICE";
