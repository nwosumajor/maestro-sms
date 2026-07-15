// =============================================================================
// AuditPartitionService — keeps audit_log's monthly partitions rolling forward
// =============================================================================
// audit_log is RANGE-partitioned by month (migration 20260824000000). Partitions
// must exist BEFORE rows land in their month. A DEFAULT partition means a missing
// partition can never fail an INSERT — but rows would pile into DEFAULT, undoing
// the point of partitioning and making the partition impossible to add later
// without moving them. So this sweep pre-creates the next few months, daily.
//
// DELIBERATELY privileged (DDL): it uses the shared privileged client, exactly
// like the retention / dunning sweeps. With no privileged URL configured it is a
// no-op rather than an error — mirrors those services' disabled posture.
//
// The DDL itself lives in the DB as `ensure_audit_log_partition(date)` (created by
// the migration) so partition shape + its RLS are defined in ONE place; this
// service only decides WHEN to call it. The function is idempotent.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { AUDIT_PARTITION_MONTHS_AHEAD } from "./maintenance.constants";

export interface AuditPartitionResult {
  ensured: string[];
  /** Rows sitting in the DEFAULT partition — should be 0. Non-zero means a month
   *  went un-provisioned and needs manual attention (see logs). */
  defaultRows: number;
  skipped?: "no-privileged-client";
}

@Injectable()
export class AuditPartitionService {
  private readonly logger = new Logger("AuditPartition");

  constructor(private readonly privileged: PrivilegedDatabaseService) {}

  /** Ensure partitions exist for the current month and the next N months. */
  async ensureUpcoming(monthsAhead = AUDIT_PARTITION_MONTHS_AHEAD): Promise<AuditPartitionResult> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn("No privileged DB client — audit partition maintenance DISABLED (no-op).");
      return { ensured: [], defaultRows: 0, skipped: "no-privileged-client" };
    }

    const ensured: string[] = [];
    const now = new Date();
    for (let i = 0; i <= monthsAhead; i++) {
      // First of the target month, in UTC (partition bounds are month boundaries).
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const iso = month.toISOString().slice(0, 10);
      const rows = await client.$queryRawUnsafe<{ ensure_audit_log_partition: string }[]>(
        "SELECT ensure_audit_log_partition($1::date)",
        iso,
      );
      const name = rows[0]?.ensure_audit_log_partition;
      if (name) ensured.push(name);
    }

    // The DEFAULT partition must stay empty; anything in it means we missed a month.
    const [{ count }] = await client.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*)::bigint AS count FROM "audit_log_default"',
    );
    const defaultRows = Number(count);
    if (defaultRows > 0) {
      this.logger.error(
        `audit_log_default holds ${defaultRows} row(s) — a month was not pre-created. ` +
          "Those rows must be migrated into a real partition before one can be added for their month.",
      );
    }
    this.logger.log(`Audit partitions ensured: ${ensured.join(", ")} (default rows: ${defaultRows}).`);
    return { ensured, defaultRows };
  }
}
