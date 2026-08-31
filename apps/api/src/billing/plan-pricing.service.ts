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
    const table = (await this.resolve()).pricing[currency];
    // A currency the platform can EXPRESS but has no price list for. Refusing is
    // the point: quoting a tier at zero, or silently at the naira price, is worse
    // than saying the market is not open yet.
    if (!table) {
      throw new ServiceUnavailableException(
        `No plan pricing for ${currency}. Set prices for it in the operator pricing console before selling in this currency.`,
      );
    }
    return table;
  }

  /** All currencies at once (quote fan-out). */
  async effectiveAll(): Promise<MultiCurrencyPlanPricing> {
    return (await this.resolve()).pricing;
  }

  /** Per-(tier, currency) list with default/override flags (operator console +
   *  public page). Only SELLABLE combos appear. */
  async list(): Promise<PlanPriceDto[]> {
    const { pricing, overridden } = await this.resolve();
    return (Object.values(PLANS) as Plan[]).flatMap((plan) =>
      planCurrencies(plan).map((currency) => ({
        plan,
        currency,
        perSeatMonthlyMinor: pricing[currency]?.[plan].perSeatMonthlyMinor ?? 0,
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
      // Refuse a price in a currency the tier is not sold in — it would leak
      // onto the homepage and checkout as a quote nothing can charge.
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
    // EVERY SHIPPED CURRENCY, not a hand-kept pair.
    //
    // This listed NGN and USD literally, so adding GHS to
    // `PLAN_PRICING_BY_CURRENCY` changed nothing here and cedi quotes came out
    // at NAIRA numbers — GHS 525 a seat instead of GHS 3.50, about 150x.
    // Measured on the live Ghanaian tenant before the fix. A shipped list that
    // the resolver does not read is not a price list.
    const pricing: MultiCurrencyPlanPricing = {};
    for (const [currency, table] of Object.entries(PLAN_PRICING_BY_CURRENCY)) {
      if (isCurrency(currency)) pricing[currency] = { ...table };
    }
    const overridden = new Set<string>();
    // A currency the platform ships NO list for, opened by operator rows alone.
    // Its tiers start ABSENT rather than copied from naira — see below.
    const openedByOperator = new Set<string>();
    for (const r of rows) {
      if (isPlan(r.plan) && isCurrency(r.currency)) {
        // An operator row can OPEN a currency the defaults do not cover — pricing
        // a new market is a price list, not a deploy.
        //
        // IT NO LONGER INHERITS NAIRA. The table used to be created as a COPY of
        // the NGN list, so an operator who priced STANDARD in a new currency
        // silently sold the other three tiers at naira figures — the exact
        // "silently at the naira price" this file's own refusal exists to
        // prevent, reached through the other door. Unpriced tiers stay at zero
        // and `effective()` refuses the currency until every tier has a price.
        if (!PLAN_PRICING_BY_CURRENCY[r.currency]) openedByOperator.add(r.currency);
        const table = (pricing[r.currency] ??= {} as PlanPricing);
        table[r.plan] = { perSeatMonthlyMinor: r.perSeatMonthlyMinor };
        overridden.add(`${r.plan}:${r.currency}`);
      }
    }
    // A half-priced market is not open. Refusing names the tiers still missing,
    // which is what an operator needs to finish the job.
    for (const currency of openedByOperator) {
      if (!isCurrency(currency)) continue;
      const table = pricing[currency];
      const missing = (Object.values(PLANS) as Plan[]).filter((plan) => !table?.[plan]);
      if (missing.length > 0) delete pricing[currency];
    }
    this.cache = { at: now, pricing, overridden };
    return this.cache;
  }
}
