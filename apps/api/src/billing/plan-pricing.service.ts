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

import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleInit,
} from "@nestjs/common";
import { prisma } from "@sms/db";
import {
  CURRENCIES,
  PLANS,
  PLAN_MODULES,
  PLAN_PRICING_BY_CURRENCY,
  isCurrency,
  isPlan,
  planCurrencies,
  type Currency,
  type MultiCurrencyPlanPricing,
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
import { RedisPubSubService } from "../common/redis-pubsub.service";

/** Pricing changes are rare; a short TTL keeps quotes fresh without a query per quote. */
const CACHE_TTL_MS = 60_000;
/** Sanity ceiling: ₦1,000,000 per seat per month (in kobo). */
const MAX_PER_SEAT_MINOR = 100_000_000;
/** Cross-instance cache-drop channel (mirrors entitlement:invalidate). */
const INVALIDATE_CHANNEL = "plan-pricing:invalidate";

@Injectable()
export class PlanPricingService implements OnModuleInit {
  private cache: { at: number; pricing: MultiCurrencyPlanPricing; overridden: Set<string> } | null = null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    @Optional() private readonly pubsub?: RedisPubSubService,
  ) {}

  onModuleInit(): void {
    // An operator pricing write on ANOTHER task must drop our stale copy too —
    // otherwise a replica keeps quoting the old price for up to CACHE_TTL_MS.
    this.pubsub?.subscribe(INVALIDATE_CHANNEL, () => {
      this.cache = null;
    });
  }

  /** Effective per-tier pricing for ONE currency (operator rows over defaults).
   *  Defaults to NGN so existing single-currency callers keep working. */
  async effective(currency: Currency = CURRENCIES.NGN): Promise<PlanPricing> {
    return (await this.resolve()).pricing[currency];
  }

  /** All currencies at once (quote fan-out). */
  async effectiveAll(): Promise<MultiCurrencyPlanPricing> {
    return (await this.resolve()).pricing;
  }

  /** Per-(tier, currency) list with default/override flags (operator console +
   *  public page). Only SELLABLE combos appear — ENTERPRISE is USD-only. */
  async list(): Promise<PlanPriceDto[]> {
    const { pricing, overridden } = await this.resolve();
    return (Object.values(PLANS) as Plan[]).flatMap((plan) =>
      planCurrencies(plan).map((currency) => ({
        plan,
        currency,
        perSeatMonthlyMinor: pricing[currency][plan].perSeatMonthlyMinor,
        isDefault: !overridden.has(`${plan}:${currency}`),
        modulesIncluded: PLAN_MODULES[plan].length,
      })),
    );
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
    const rows = input.prices.map((row) => ({ ...row, currency: row.currency ?? CURRENCIES.NGN }));
    for (const row of rows) {
      if (!isPlan(row.plan)) throw new BadRequestException(`unknown plan tier: ${row.plan}`);
      if (!isCurrency(row.currency)) throw new BadRequestException(`unknown currency: ${String(row.currency)}`);
      // ENTERPRISE is indicated/sold in USD only — an NGN price would leak onto
      // the homepage and checkout, so refuse to store one at all.
      if (!planCurrencies(row.plan).includes(row.currency)) {
        throw new BadRequestException(`${row.plan} is billed in ${planCurrencies(row.plan).join("/")} only`);
      }
      if (
        !Number.isInteger(row.perSeatMonthlyMinor) ||
        row.perSeatMonthlyMinor <= 0 ||
        row.perSeatMonthlyMinor > MAX_PER_SEAT_MINOR
      ) {
        throw new BadRequestException(
          `perSeatMonthlyMinor for ${row.plan} must be a positive integer (minor units) ≤ ${MAX_PER_SEAT_MINOR}`,
        );
      }
    }

    for (const row of rows) {
      await client.planPrice.upsert({
        where: { plan_currency: { plan: row.plan, currency: row.currency } },
        update: { perSeatMonthlyMinor: row.perSeatMonthlyMinor },
        create: { plan: row.plan, currency: row.currency, perSeatMonthlyMinor: row.perSeatMonthlyMinor },
      });
    }
    // Drop this task's cache AND every other replica's (Redis fan-out; local
    // delivery is direct, so this also covers the no-Redis dev setup).
    this.cache = null;
    this.pubsub?.publish(INVALIDATE_CHANNEL, { at: Date.now() });

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

  private async resolve(): Promise<{ pricing: MultiCurrencyPlanPricing; overridden: Set<string> }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache;
    // Global read, no tenant context (RLS SELECT policy is USING(true) — rls/46).
    const rows = await prisma.planPrice.findMany();
    const pricing: MultiCurrencyPlanPricing = {
      NGN: { ...PLAN_PRICING_BY_CURRENCY.NGN },
      USD: { ...PLAN_PRICING_BY_CURRENCY.USD },
    };
    const overridden = new Set<string>();
    for (const r of rows) {
      if (isPlan(r.plan) && isCurrency(r.currency)) {
        pricing[r.currency][r.plan] = { perSeatMonthlyMinor: r.perSeatMonthlyMinor };
        overridden.add(`${r.plan}:${r.currency}`);
      }
    }
    this.cache = { at: now, pricing, overridden };
    return this.cache;
  }
}
