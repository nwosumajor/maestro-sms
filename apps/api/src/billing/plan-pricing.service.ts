// =============================================================================
// PlanPricingService — operator-set per-tier pricing over platform defaults
// =============================================================================
// The single resolver for "what does a tier cost per seat per month?". Reads the
// GLOBAL `plan_price` table (RLS-exempt, SELECT-only for the app role — see
// rls/46) and merges any rows over the @sms/types PLAN_PRICING constants, so a
// tier without an override keeps its default. Consumed by the billing overview
// quotes, checkout charging, and the PUBLIC pricing endpoint — one source of
// effective truth, so what the landing page shows is what checkout charges.
//
// Reads use the plain app-role client OUTSIDE a tenant transaction (the table is
// global and carries no tenant data — same precedent as the auth login lookup),
// with a short TTL cache. Writes are super_admin-only via the PRIVILEGED client
// (the app role has no write grant — least privilege), step-up gated at the
// controller, audited in the operator's own tenant, and invalidate the cache.
// =============================================================================

import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { prisma } from "@sms/db";
import {
  PLANS,
  PLAN_MODULES,
  PLAN_PRICING,
  isPlan,
  type Plan,
  type PlanPriceDto,
  type PlanPriceUpdateDto,
  type PlanPricing,
} from "@sms/types";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
  type AuditLogService,
  type Principal,
  type TenantDatabase,
} from "../integrity/integrity.foundation";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

/** Pricing changes are rare; a short TTL keeps quotes fresh without a query per quote. */
const CACHE_TTL_MS = 60_000;
/** Sanity ceiling: ₦1,000,000 per seat per month (in kobo). */
const MAX_PER_SEAT_MINOR = 100_000_000;

@Injectable()
export class PlanPricingService {
  private cache: { at: number; pricing: PlanPricing; overridden: Set<Plan> } | null = null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
  ) {}

  /** Effective per-tier pricing: operator rows merged over the platform defaults. */
  async effective(): Promise<PlanPricing> {
    return (await this.resolve()).pricing;
  }

  /** Per-tier list with default/override flags (operator console + public page). */
  async list(): Promise<PlanPriceDto[]> {
    const { pricing, overridden } = await this.resolve();
    return (Object.values(PLANS) as Plan[]).map((plan) => ({
      plan,
      perSeatMonthlyMinor: pricing[plan].perSeatMonthlyMinor,
      isDefault: !overridden.has(plan),
      modulesIncluded: PLAN_MODULES[plan].length,
    }));
  }

  /**
   * super_admin: set per-tier prices (partial — only the tiers provided change).
   * Privileged-client write (503 when no privileged URL); audited; cache dropped.
   */
  async update(p: Principal, input: PlanPriceUpdateDto): Promise<PlanPriceDto[]> {
    const client = this.privileged.client;
    if (!client) {
      throw new ServiceUnavailableException(
        "Pricing management requires the privileged database configuration",
      );
    }
    if (!input.prices?.length) throw new BadRequestException("prices must be a non-empty array");
    for (const row of input.prices) {
      if (!isPlan(row.plan)) throw new BadRequestException(`unknown plan tier: ${row.plan}`);
      if (
        !Number.isInteger(row.perSeatMonthlyMinor) ||
        row.perSeatMonthlyMinor <= 0 ||
        row.perSeatMonthlyMinor > MAX_PER_SEAT_MINOR
      ) {
        throw new BadRequestException(
          `perSeatMonthlyMinor for ${row.plan} must be a positive integer (kobo) ≤ ${MAX_PER_SEAT_MINOR}`,
        );
      }
    }

    for (const row of input.prices) {
      await client.planPrice.upsert({
        where: { plan: row.plan },
        update: { perSeatMonthlyMinor: row.perSeatMonthlyMinor },
        create: { plan: row.plan, perSeatMonthlyMinor: row.perSeatMonthlyMinor },
      });
    }
    this.cache = null;

    // Audited in the operator's own (platform) tenant, like other operator writes.
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "operator.pricing.update",
          entity: "plan_price",
          entityId: "platform",
          schoolId: p.schoolId,
          metadata: { prices: input.prices },
        },
        tx,
      ),
    );

    return this.list();
  }

  private async resolve(): Promise<{ pricing: PlanPricing; overridden: Set<Plan> }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache;
    // Global read, no tenant context (RLS SELECT policy is USING(true) — rls/46).
    const rows = await prisma.planPrice.findMany();
    const pricing: PlanPricing = { ...PLAN_PRICING };
    const overridden = new Set<Plan>();
    for (const r of rows) {
      if (isPlan(r.plan)) {
        pricing[r.plan] = { perSeatMonthlyMinor: r.perSeatMonthlyMinor };
        overridden.add(r.plan);
      }
    }
    this.cache = { at: now, pricing, overridden };
    return this.cache;
  }
}
