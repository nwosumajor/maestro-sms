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

import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import {
  BILLING_CYCLES,
  DEFAULT_PLAN,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_STATUS,
  effectivePlan,
  isBillingCycle,
  isPlan,
  isSubscriptionStatus,
  resolveModules,
  type BillingCycle,
  type ModuleKey,
  type ModuleOverrides,
  type Plan,
  type SubscriptionDto,
  type SubscriptionStatus,
} from "@sms/types";
import {
  TENANT_DATABASE,
  type TenantDatabase,
  type TenantTx,
} from "../integrity/integrity.foundation";
import { RedisPubSubService } from "../common/redis-pubsub.service";

const CACHE_TTL_MS = 30_000;
/** Redis channel: "drop the cached entitlements for this school on every task". */
const INVALIDATE_CHANNEL = "entitlement:invalidate";

interface Resolved {
  /** The PURCHASED tier (never downgraded by delinquency). */
  plan: Plan;
  /** The tier ENFORCED right now (BASIC when past-due beyond grace). */
  effectivePlan: Plan;
  overrides: ModuleOverrides;
  /** Effective enabled modules, resolved against `effectivePlan`. */
  modules: ModuleKey[];
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currentPeriodEnd: Date | null;
  seats: number | null;
  priceMinor: number | null;
}

@Injectable()
export class ModuleEntitlementService implements OnModuleInit {
  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Optional() private readonly pubsub?: RedisPubSubService,
  ) {}

  private cache = new Map<string, { at: number; value: Resolved }>();

  onModuleInit(): void {
    // A billing webhook / operator write on ANOTHER task must drop our stale copy.
    this.pubsub?.subscribe(INVALIDATE_CHANNEL, (payload) => {
      const schoolId = (payload as { schoolId?: string })?.schoolId;
      if (schoolId) this.cache.delete(schoolId);
    });
  }

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
      tx.schoolSubscription.findFirst({
        where: { schoolId },
        select: {
          plan: true,
          overrides: true,
          status: true,
          billingCycle: true,
          currentPeriodEnd: true,
          seats: true,
          priceMinor: true,
        },
      }),
    );
    const plan: Plan = row && isPlan(row.plan) ? (row.plan as Plan) : DEFAULT_PLAN;
    const overrides = (row?.overrides ?? {}) as ModuleOverrides;
    const status: SubscriptionStatus =
      row && isSubscriptionStatus(row.status) ? (row.status as SubscriptionStatus) : SUBSCRIPTION_STATUS.ACTIVE;
    const billingCycle: BillingCycle =
      row && isBillingCycle(row.billingCycle) ? (row.billingCycle as BillingCycle) : BILLING_CYCLES.TERM;
    const currentPeriodEnd = row?.currentPeriodEnd ?? null;
    // Delinquency downgrades the EFFECTIVE plan only — the stored `plan` stands,
    // so a payment restores access (next cache cycle / on invalidate).
    const eff = effectivePlan(plan, status, currentPeriodEnd, SUBSCRIPTION_GRACE_DAYS, new Date());
    const value: Resolved = {
      plan,
      effectivePlan: eff,
      overrides,
      modules: resolveModules(eff, overrides),
      status,
      billingCycle,
      currentPeriodEnd,
      seats: row?.seats ?? null,
      priceMinor: row?.priceMinor ?? null,
    };
    this.cache.set(schoolId, { at: Date.now(), value });
    return value;
  }

  /** Build the wire DTO from a resolved subscription (operator + billing reads). */
  dtoFrom(schoolId: string, r: Resolved): SubscriptionDto {
    return {
      schoolId,
      plan: r.plan,
      overrides: r.overrides,
      modules: r.modules,
      status: r.status,
      billingCycle: r.billingCycle,
      currentPeriodEnd: r.currentPeriodEnd,
      seats: r.seats,
      priceMinor: r.priceMinor,
      effectivePlan: r.effectivePlan,
    };
  }

  /** Invalidate the cache for a school (call after a subscription write). Clears
   *  this task immediately AND tells every other task to do the same. */
  invalidate(schoolId: string): void {
    this.cache.delete(schoolId);
    this.pubsub?.publish(INVALIDATE_CHANNEL, { schoolId });
  }
}

export const MODULE_ENTITLEMENT_SERVICE = "MODULE_ENTITLEMENT_SERVICE";
