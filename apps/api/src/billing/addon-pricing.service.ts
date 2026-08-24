// =============================================================================
// AddonPricingService — operator-set price for ONE module, bought on its own
// =============================================================================
// The exact posture of PlanPricingService, deliberately: a global registry read
// by the app role and written only through the privileged client behind the
// operator's step-up-gated PUT, cached briefly with a cross-instance drop so a
// price change reaches every task rather than one.
//
// A MISSING ROW IS NOT ZERO. `MODULE_ADDON_PRICING` in @sms/types is the
// fallback, the same way `PLAN_PRICING` backs the tier table — an unpriced
// module quotes the code default rather than becoming free, which is the
// direction that cannot lose money by accident.
// =============================================================================

import { Inject, Injectable, OnModuleInit, Optional, BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import {
  CURRENCIES,
  MODULES,
  MODULE_ADDON_PRICING,
  NOT_SOLD_SEPARATELY,
  PLANS,
  PLAN_MODULES,
  isModuleKey,
  type Currency,
  type ModuleAddonPriceDto,
  type ModuleKey,
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

const CACHE_TTL_MS = 60_000;
/** Same ceiling as a tier price: nothing sane exceeds it, and a fat-fingered
 *  extra zero on a per-seat figure is a bill nobody can pay. */
const MAX_PER_SEAT_MINOR = 100_000_000;
const INVALIDATE_CHANNEL = "addon-pricing:invalidate";

type Table = Partial<Record<ModuleKey, number>>;

/** The modules that CAN be sold alone: everything above the entry tier, minus
 *  the deliberate sweeteners. Derived, so repackaging cannot leave it stale. */
export function sellableAlone(): ModuleKey[] {
  const core = new Set(PLAN_MODULES[PLANS.STANDARD]);
  const never = new Set(NOT_SOLD_SEPARATELY);
  return PLAN_MODULES[PLANS.ENTERPRISE].filter((m) => !core.has(m) && !never.has(m));
}

@Injectable()
export class AddonPricingService implements OnModuleInit {
  private cache: { at: number; byCurrency: Record<string, Table>; overridden: Set<string> } | null = null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    @Optional() private readonly pubsub?: RedisPubSubService,
  ) {}

  onModuleInit(): void {
    this.pubsub?.subscribe(INVALIDATE_CHANNEL, () => {
      this.cache = null;
    });
  }

  /** Effective add-on prices for one currency: operator rows over code defaults. */
  async effective(currency: Currency = CURRENCIES.NGN): Promise<Table> {
    const { byCurrency } = await this.resolve();
    return byCurrency[currency] ?? { ...MODULE_ADDON_PRICING };
  }

  /** Operator console + the school's own add-on shop. */
  async list(currency: Currency = CURRENCIES.NGN): Promise<ModuleAddonPriceDto[]> {
    const { byCurrency, overridden } = await this.resolve();
    const table = byCurrency[currency] ?? {};
    return sellableAlone().map((module) => ({
      module,
      currency,
      perSeatMonthlyMinor: table[module] ?? MODULE_ADDON_PRICING[module] ?? 0,
      isDefault: !overridden.has(`${module}:${currency}`),
    }));
  }

  /**
   * Set prices. Privileged write, audited by the caller's controller.
   *
   * Validated hard, because this is the one place a typo becomes a charge: a
   * real module key, a module that is actually sold alone, a non-negative
   * integer, and under the ceiling.
   */
  async update(p: Principal, rows: Array<{ module: string; currency: string; perSeatMonthlyMinor: number }>): Promise<ModuleAddonPriceDto[]> {
    const client = this.privileged.client;
    if (!client) throw new ServiceUnavailableException("Add-on pricing requires the privileged database configuration");
    const allowed = new Set<string>(sellableAlone());
    for (const r of rows) {
      if (!isModuleKey(r.module) || !allowed.has(r.module)) {
        throw new BadRequestException(`${r.module} is not a module that can be bought on its own`);
      }
      if (!Number.isInteger(r.perSeatMonthlyMinor) || r.perSeatMonthlyMinor < 0) {
        throw new BadRequestException("A price must be a whole number of minor units, and never negative");
      }
      if (r.perSeatMonthlyMinor > MAX_PER_SEAT_MINOR) {
        throw new BadRequestException("That price is beyond the sanity ceiling — check for an extra zero");
      }
      if (r.currency !== CURRENCIES.NGN && r.currency !== CURRENCIES.USD) {
        throw new BadRequestException("Add-ons are priced in NGN or USD");
      }
    }
    for (const r of rows) {
      await client.moduleAddonPrice.upsert({
        where: { module_currency: { module: r.module, currency: r.currency } },
        create: { module: r.module, currency: r.currency, perSeatMonthlyMinor: r.perSeatMonthlyMinor },
        update: { perSeatMonthlyMinor: r.perSeatMonthlyMinor },
      });
    }
    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "platform.addon_pricing.update",
          entity: "module_addon_price",
          entityId: p.schoolId,
          schoolId: p.schoolId,
          metadata: { rows: rows.map((r) => ({ module: r.module, currency: r.currency, perSeatMonthlyMinor: r.perSeatMonthlyMinor })) },
        },
        tx,
      ),
    );
    this.cache = null;
    this.pubsub?.publish(INVALIDATE_CHANNEL, "1");
    return this.list(CURRENCIES.NGN);
  }

  private async resolve(): Promise<{ byCurrency: Record<string, Table>; overridden: Set<string> }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache;
    const byCurrency: Record<string, Table> = {
      [CURRENCIES.NGN]: { ...MODULE_ADDON_PRICING },
      [CURRENCIES.USD]: { ...MODULE_ADDON_PRICING },
    };
    const overridden = new Set<string>();
    // The APP role may read this table (rls/111), so no privileged client is
    // needed for the read path — quotes and renewals run on the ordinary client.
    const rows = await this.db.runAsTenantReadOnly({ schoolId: ZERO_UUID, userId: ZERO_UUID }, (tx) =>
      tx.moduleAddonPrice.findMany(),
    );
    for (const r of rows as Array<{ module: string; currency: string; perSeatMonthlyMinor: number }>) {
      if (!isModuleKey(r.module)) continue;
      (byCurrency[r.currency] ??= {})[r.module] = r.perSeatMonthlyMinor;
      overridden.add(`${r.module}:${r.currency}`);
    }
    this.cache = { at: now, byCurrency, overridden };
    return this.cache;
  }
}

/** The placeholder tenant used for global-registry reads (see PublicService). */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Re-exported so callers do not reach into @sms/types for the key set. */
export const ADDON_MODULES = MODULES;
