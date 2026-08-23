// =============================================================================
// A school that has been switched off reaches nothing
// =============================================================================
// DISABLED is the operator's hard lever, and it meant one thing: the LOGIN was
// refused. Everything else went on working.
//
//   * a session already open kept refreshing — `refreshClaims` checked the
//     USER's status, never the school's — so anybody signed in when the switch
//     was thrown stayed signed in, indefinitely, as long as they kept clicking;
//   * an invite link and a password-reset link still completed;
//   * two nightly sweeps still billed and messaged the school's families.
//
// "Not being able to start a new session" is not the same as "no access". This
// is the check that makes it the same: every authenticated request from a
// school that is not ACTIVE is refused, wherever it lands.
//
// CACHED, and briefly. The school registry is global and this runs on every
// request, so an uncached read would be a query per request; but a long TTL
// means a school keeps working for minutes after being switched off, which is
// the thing being fixed. Fifteen seconds, plus an explicit invalidation the
// moment the operator flips the switch, fanned across instances on the same
// Redis channel the entitlement cache uses — so in practice it is immediate and
// the TTL is only a backstop for a missed message.
//
// SUPER_ADMIN IS EXEMPT. The platform owner must be able to reach the operator
// console to switch the school back on; locking the lever inside the thing it
// controls is how a school stays disabled for ever.
// =============================================================================

import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { RedisPubSubService } from "../common/redis-pubsub.service";
import { TENANT_DATABASE, type TenantDatabase, type TenantTx } from "../integrity/integrity.foundation";

/** Short: a switched-off school must stop being served in seconds, not minutes. */
const TTL_MS = 15_000;

/** Same fan-out the entitlement cache uses, so one instance's write reaches all. */
export const SCHOOL_STATUS_CHANNEL = "school-status:invalidate";

@Injectable()
export class SchoolStatusService implements OnModuleInit {
  private readonly cache = new Map<string, { at: number; active: boolean }>();

  constructor(
    @Inject(TENANT_DATABASE) private readonly db: TenantDatabase,
    private readonly pubsub: RedisPubSubService,
  ) {}

  onModuleInit(): void {
    this.pubsub.subscribe(SCHOOL_STATUS_CHANNEL, (payload) => {
      const schoolId = (payload as { schoolId?: string })?.schoolId;
      if (schoolId) this.cache.delete(schoolId);
      else this.cache.clear();
    });
  }

  /** Is this school switched on? Unknown schools read as INACTIVE, not active. */
  async isActive(schoolId: string): Promise<boolean> {
    const hit = this.cache.get(schoolId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.active;
    const row = await this.db.runAsTenant({ schoolId, userId: schoolId }, async (tx: TenantTx) =>
      (await tx.school.findFirst({ where: { id: schoolId }, select: { status: true } })) as { status: string } | null,
    );
    // A school the read cannot find is not a school to serve. Failing towards
    // "inactive" is the restrictive option (Golden Rule #7) and the honest one:
    // the alternative is serving a tenant nobody can account for.
    const active = row?.status === "ACTIVE";
    this.cache.set(schoolId, { at: Date.now(), active });
    return active;
  }

  /** Called by the operator write, so the switch takes effect at once. */
  invalidate(schoolId: string): void {
    this.cache.delete(schoolId);
    this.pubsub.publish(SCHOOL_STATUS_CHANNEL, { schoolId });
  }
}
