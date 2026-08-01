// =============================================================================
// SchoolRegionService — what day is it, where this school is
// =============================================================================
// Every service that decides "today" must ask the SCHOOL, not the server. The
// server's UTC day is the wrong day for most of the world:
//
//   Singapore (UTC+8)  Monday 07:30 local = Sunday 23:30 UTC
//   Toronto   (UTC-5)  Monday 19:30 local = Tuesday 00:30 UTC
//
// so a register, a gate scan or a stale-register check that used `new Date()` was
// filing against the wrong calendar day for anyone outside West Africa.
//
// Cached like ModuleEntitlementService: this is read on nearly every attendance
// request and the answer changes about once in a school's lifetime. The app role
// is SELECT-only on the global `school` table, which is all this needs.
// =============================================================================

import { Inject, Injectable } from "@nestjs/common";
import { DEFAULT_COUNTRY, resolveRegion, schoolToday, type RegionProfile } from "@sms/types";
import { TENANT_DATABASE, type TenantDatabase, type TenantTx } from "../integrity/integrity.foundation";

const TTL_MS = 60_000;

@Injectable()
export class SchoolRegionService {
  private readonly cache = new Map<string, { at: number; region: RegionProfile }>();

  constructor(@Inject(TENANT_DATABASE) private readonly db: TenantDatabase) {}

  /** Drop a school's cached region after its registry row is edited. */
  invalidate(schoolId: string): void {
    this.cache.delete(schoolId);
  }

  /**
   * The school's region, from INSIDE an existing tenant transaction.
   *
   * Preferred over `forSchool` wherever a tx is already open: it avoids opening a
   * second connection in the middle of a register write, and it reads the row
   * under the same RLS context as everything else in that transaction.
   */
  async inTx(tx: TenantTx, schoolId: string): Promise<RegionProfile> {
    const hit = this.cache.get(schoolId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.region;
    const row = (await tx.school.findFirst({
      where: { id: schoolId },
      select: { country: true, timezone: true, locale: true, currency: true, complianceRegime: true },
    })) as {
      country: string | null;
      timezone: string | null;
      locale: string | null;
      currency: string | null;
      complianceRegime: string | null;
    } | null;
    // A school we cannot read is the platform's home region, not an error: the
    // caller is taking a register, and refusing one because a lookup missed would
    // be a worse outcome than a date in the default zone.
    const region = resolveRegion(row ?? { country: DEFAULT_COUNTRY });
    this.cache.set(schoolId, { at: Date.now(), region });
    return region;
  }

  /** The school's region, opening its own read transaction. */
  async forSchool(schoolId: string): Promise<RegionProfile> {
    const hit = this.cache.get(schoolId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.region;
    return this.db.runAsTenantReadOnly({ schoolId, userId: "system" }, (tx) => this.inTx(tx, schoolId));
  }

  /** The school's current calendar day, as the UTC-midnight Date every `@db.Date`
   *  column in this schema stores. */
  async todayInTx(tx: TenantTx, schoolId: string): Promise<Date> {
    return schoolToday((await this.inTx(tx, schoolId)).timezone);
  }
}
