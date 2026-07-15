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
// school for a TTL (see CACHE_TTL_MS). A school with NO row FAILS CLOSED to
// DEFAULT_PLAN = STANDARD (core teaching): a data gap under-provisions rather
// than silently giving away the premium suite. Onboarding writes an explicit
// row for every school, so this only ever bites truly row-less tenants —
// live-verified: a row-less school 404s on an ENTERPRISE module (hr) while
// STANDARD modules (lms) still work.
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

// This cache is on the hot path of (almost) EVERY request, so its miss rate is a
// direct scaling limit: with a process-local TTL, each school reloads once per
// TTL, so misses/sec = tenants / TTL — INDEPENDENT of traffic. Measured at 5,000
// tenants a 30s TTL meant 5000/30 = ~167 reloads/sec, i.e. ~35% of all requests
// paying for a full interactive transaction (BEGIN + 2×set_config + SELECT +
// COMMIT) just to check entitlement — module-gated endpoints ran 4× slower than
// always-on ones and total throughput fell 38%. At 10 minutes that is ~8/sec
// (~1.7%), and the cost stops scaling with tenant count.
//
// SAFE because the TTL is NOT the correctness mechanism: every subscription write
// calls invalidate(), which drops the entry on THIS task and publishes to all
// others (see RedisPubSubService) — so a plan change still applies immediately.
// The TTL is only a backstop for the degraded case where Redis pub/sub is down;
// there, a change takes up to this long to propagate. Tolerable: module gating is
// a BILLING gate, not a security one (permissions + RLS are the security layers),
// and it fails toward the previously-purchased plan, never toward more access.
const CACHE_TTL_MS = 600_000;
/** Bound memory at high tenant counts — evict oldest once past this many schools.
 *  Keep this WELL ABOVE the tenant count: eviction here is insertion-order (FIFO),
 *  not LRU, so a bound at/below the number of active schools evicts entries that
 *  are still hot and reintroduces the miss storm this cache exists to prevent.
 *  ~500B/entry ⇒ 50k ≈ 25MB per task, cheap next to the round-trips it saves. */
const CACHE_MAX_ENTRIES = 50_000;
/** Redis channel: "drop the cached entitlements for this school on every task". */
const INVALIDATE_CHANNEL = "entitlement:invalidate";

interface Resolved {
  /** The PURCHASED tier (never downgraded by delinquency). */
  plan: Plan;
  /** The tier ENFORCED right now (the STANDARD floor when past-due beyond grace). */
  effectivePlan: Plan;
  overrides: ModuleOverrides;
  /** Effective enabled modules, resolved against `effectivePlan`. */
  modules: ModuleKey[];
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  currentPeriodEnd: Date | null;
  /** Per-school grace override; null -> platform default (SUBSCRIPTION_GRACE_DAYS). */
  graceDays: number | null;
  seats: number | null;
  priceMinor: number | null;
  currency: string | null;
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
          graceDays: true,
          seats: true,
          priceMinor: true,
          currency: true,
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
    // Per-school grace wins over the platform default — set from the operator
    // console (bounded 0..GRACE_DAYS_MAX at the API).
    const graceDays = row?.graceDays ?? null;
    const eff = effectivePlan(plan, status, currentPeriodEnd, graceDays ?? SUBSCRIPTION_GRACE_DAYS, new Date());
    const value: Resolved = {
      plan,
      effectivePlan: eff,
      overrides,
      modules: resolveModules(eff, overrides),
      status,
      billingCycle,
      currentPeriodEnd,
      graceDays,
      seats: row?.seats ?? null,
      priceMinor: row?.priceMinor ?? null,
      currency: row?.currency ?? null,
    };
    this.cache.set(schoolId, { at: Date.now(), value });
    // Bound memory: a long TTL across thousands of tenants would otherwise retain
    // every school ever seen by this task. Insertion-ordered Map ⇒ oldest first.
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
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
      graceDays: r.graceDays,
      seats: r.seats,
      priceMinor: r.priceMinor,
      currency: r.currency,
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
