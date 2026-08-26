// =============================================================================
// PlatformFeeService — the platform's take-rate on ONLINE fee collection
// =============================================================================
// Single resolver for "what convenience fee applies to an online school-fee
// payment?". Reads the GLOBAL `platform_fee_config` row (RLS-exempt, SELECT-only
// for the app role — rls/71) with the SAME posture as PlanPricingService: short
// TTL cache, Redis fan-out invalidation, privileged-client writes (operator PUT,
// step-up gated at the controller, audited). Missing row ⇒ DEFAULT_PLATFORM_FEE
// (ZERO — fail-safe: no school is charged until the operator opts in).
//
// PER CURRENCY, and that is not decoration. The take-rate rides the Paystack
// split and Paystack settles NGN, GHS, ZAR, KES and USD, while this was a
// SINGLETON carrying `flatMinor`/`capMinor` in kobo with no currency at all.
// Measured against the live row (150bp capped at 200,000): an NGN 150,000
// invoice charged the parent NGN 2,000 exactly as intended, while the same
// "cap" read GHS 2,000, KES 2,000 and ZAR 2,000 — 12x to 100x above the
// intended ceiling, so it never binds and the full 150bp is charged uncapped on
// a fee the PARENT bears. A currency with no row therefore charges NOTHING,
// which is the same fail-safe this header already promised for a missing row:
// an unset CHARGE goes to zero, because a charge that guesses bills a family.
//
// The fee itself is taken at the GATEWAY via the split's `transaction_charge`,
// so it never passes through the school's settlement; who BEARS it (payer pays
// invoice+fee vs school nets invoice−fee) is the school's own choice
// (school.paymentFeeBearer), falling back to the config's default.
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
  DEFAULT_PLATFORM_FEE,
  isPlatformFeeBearer,
  type PlatformFeeConfig,
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
/** The platform's home currency — what the historical singleton was authored in. */
const DEFAULT_FEE_CURRENCY = "NGN";
const CONFIG_ID = "fees";
const INVALIDATE_CHANNEL = "platform-fee:invalidate";
/** Sanity ceilings: flat ≤ ₦10,000; percent ≤ 10%; cap ≤ ₦100,000 (kobo). */
const MAX_FLAT_MINOR = 1_000_000;
const MAX_PERCENT_BP = 1_000;
const MAX_CAP_MINOR = 10_000_000;

@Injectable()
export class PlatformFeeService implements OnModuleInit {
  private cache = new Map<string, { at: number; cfg: PlatformFeeConfig }>();

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    @Inject(AUDIT_LOG_SERVICE) private readonly audit: AuditLogService,
    private readonly privileged: PrivilegedDatabaseService,
    @Optional() private readonly pubsub?: RedisPubSubService,
  ) {}

  onModuleInit(): void {
    this.pubsub?.subscribe(INVALIDATE_CHANNEL, () => {
      this.cache.clear();
    });
  }

  /**
   * The effective platform fee for ONE currency.
   *
   * `flatMinor` and `capMinor` are minor units OF THAT CURRENCY. A currency with
   * no row returns the ZERO default — never another currency's figures, which is
   * what a naira cap applied to a cedi payment amounted to.
   */
  async effective(currency: string = DEFAULT_FEE_CURRENCY): Promise<PlatformFeeConfig> {
    const key = currency.toUpperCase();
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.cfg;
    // Global read, no tenant context (RLS SELECT policy is USING(true) — rls/71).
    const row = await prisma.platformFeeConfig.findFirst({ where: { id: CONFIG_ID, currency: key } });
    const cfg: PlatformFeeConfig = row
      ? {
          flatMinor: row.flatMinor,
          percentBp: row.percentBp,
          capMinor: row.capMinor,
          bearer: isPlatformFeeBearer(row.bearer) ? row.bearer : DEFAULT_PLATFORM_FEE.bearer,
        }
      : DEFAULT_PLATFORM_FEE;
    this.cache.set(key, { at: now, cfg });
    return cfg;
  }

  /** super_admin: set the platform fee. Privileged write; audited; cache dropped. */
  async update(
    p: Principal,
    input: PlatformFeeConfig,
    currency: string = DEFAULT_FEE_CURRENCY,
  ): Promise<PlatformFeeConfig> {
    const key = currency.toUpperCase();
    const client = this.privileged.client;
    if (!client) {
      throw new ServiceUnavailableException("Fee management requires the privileged database configuration");
    }
    if (!Number.isInteger(input.flatMinor) || input.flatMinor < 0 || input.flatMinor > MAX_FLAT_MINOR) {
      throw new BadRequestException(`flatMinor must be an integer 0–${MAX_FLAT_MINOR} (minor units of ${key})`);
    }
    if (!Number.isInteger(input.percentBp) || input.percentBp < 0 || input.percentBp > MAX_PERCENT_BP) {
      throw new BadRequestException(`percentBp must be an integer 0–${MAX_PERCENT_BP} (basis points; 100 = 1%)`);
    }
    if (
      input.capMinor != null &&
      (!Number.isInteger(input.capMinor) || input.capMinor < 0 || input.capMinor > MAX_CAP_MINOR)
    ) {
      throw new BadRequestException(`capMinor must be null or an integer 0–${MAX_CAP_MINOR} (minor units of ${key})`);
    }
    if (!isPlatformFeeBearer(input.bearer)) {
      throw new BadRequestException("bearer must be PARENT or SCHOOL");
    }

    await client.platformFeeConfig.upsert({
      where: { id_currency: { id: CONFIG_ID, currency: key } },
      update: { flatMinor: input.flatMinor, percentBp: input.percentBp, capMinor: input.capMinor, bearer: input.bearer },
      create: {
        id: CONFIG_ID,
        currency: key,
        flatMinor: input.flatMinor,
        percentBp: input.percentBp,
        capMinor: input.capMinor,
        bearer: input.bearer,
      },
    });
    this.cache.delete(key);
    this.pubsub?.publish(INVALIDATE_CHANNEL, { at: Date.now() });

    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "operator.platform_fee.update",
          entity: "platform_fee_config",
          entityId: `${CONFIG_ID}:${key}`,
          schoolId: p.schoolId,
          // The CURRENCY is part of what was changed. Without it the trail reads
          // "the take-rate was set to 150bp capped at 2,000" with no way to tell
          // which market that was, now that there is more than one.
          metadata: { ...input, currency: key },
        },
        tx,
      ),
    );
    // The currency that was just written, NOT the default. Returning
    // `effective()` echoed the NAIRA row back to an operator who had just saved
    // a cedi one — measured live: PUT {currency:"GHS",capMinor:2000} answered
    // capMinor 200000, which reads as a save that did not take.
    return this.effective(key);
  }
}
