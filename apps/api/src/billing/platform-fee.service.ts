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
const CONFIG_ID = "fees";
const INVALIDATE_CHANNEL = "platform-fee:invalidate";
/** Sanity ceilings: flat ≤ ₦10,000; percent ≤ 10%; cap ≤ ₦100,000 (kobo). */
const MAX_FLAT_MINOR = 1_000_000;
const MAX_PERCENT_BP = 1_000;
const MAX_CAP_MINOR = 10_000_000;

@Injectable()
export class PlatformFeeService implements OnModuleInit {
  private cache: { at: number; cfg: PlatformFeeConfig } | null = null;

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

  /** The effective platform fee config (defaults when no row / bad row). */
  async effective(): Promise<PlatformFeeConfig> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.cfg;
    // Global read, no tenant context (RLS SELECT policy is USING(true) — rls/71).
    const row = await prisma.platformFeeConfig.findFirst({ where: { id: CONFIG_ID } });
    const cfg: PlatformFeeConfig = row
      ? {
          flatMinor: row.flatMinor,
          percentBp: row.percentBp,
          capMinor: row.capMinor,
          bearer: isPlatformFeeBearer(row.bearer) ? row.bearer : DEFAULT_PLATFORM_FEE.bearer,
        }
      : DEFAULT_PLATFORM_FEE;
    this.cache = { at: now, cfg };
    return cfg;
  }

  /** super_admin: set the platform fee. Privileged write; audited; cache dropped. */
  async update(p: Principal, input: PlatformFeeConfig): Promise<PlatformFeeConfig> {
    const client = this.privileged.client;
    if (!client) {
      throw new ServiceUnavailableException("Fee management requires the privileged database configuration");
    }
    if (!Number.isInteger(input.flatMinor) || input.flatMinor < 0 || input.flatMinor > MAX_FLAT_MINOR) {
      throw new BadRequestException(`flatMinor must be an integer 0–${MAX_FLAT_MINOR} (kobo)`);
    }
    if (!Number.isInteger(input.percentBp) || input.percentBp < 0 || input.percentBp > MAX_PERCENT_BP) {
      throw new BadRequestException(`percentBp must be an integer 0–${MAX_PERCENT_BP} (basis points; 100 = 1%)`);
    }
    if (
      input.capMinor != null &&
      (!Number.isInteger(input.capMinor) || input.capMinor < 0 || input.capMinor > MAX_CAP_MINOR)
    ) {
      throw new BadRequestException(`capMinor must be null or an integer 0–${MAX_CAP_MINOR} (kobo)`);
    }
    if (!isPlatformFeeBearer(input.bearer)) {
      throw new BadRequestException("bearer must be PARENT or SCHOOL");
    }

    await client.platformFeeConfig.upsert({
      where: { id: CONFIG_ID },
      update: { flatMinor: input.flatMinor, percentBp: input.percentBp, capMinor: input.capMinor, bearer: input.bearer },
      create: { id: CONFIG_ID, flatMinor: input.flatMinor, percentBp: input.percentBp, capMinor: input.capMinor, bearer: input.bearer },
    });
    this.cache = null;
    this.pubsub?.publish(INVALIDATE_CHANNEL, { at: Date.now() });

    await this.db.runAsTenant({ schoolId: p.schoolId, userId: p.userId }, (tx) =>
      this.audit.record(
        {
          actorId: p.userId,
          action: "operator.platform_fee.update",
          entity: "platform_fee_config",
          entityId: CONFIG_ID,
          schoolId: p.schoolId,
          metadata: { ...input },
        },
        tx,
      ),
    );
    return this.effective();
  }
}
