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
  /**
   * The same number, under the name the operator's jobs console reads.
   *
   * `JobRunsService` derives a run's "Partial" badge from a numeric `failed` in
   * the stored summary — an opt-in convention, so a job that does not report one
   * gets `null` and always renders healthy. This job did not, so THE ONE
   * CONDITION IT EXISTS TO DETECT was unflagged: rows piling into the DEFAULT
   * partition showed up only as ordinary summary text beside every green row.
   * Exactly what was already fixed for the retention and dunning sweeps — a
   * count nobody surfaces is a count nobody acts on — and this sibling did not
   * get it. Rows in DEFAULT genuinely are "items left as they were": they must
   * be moved before a partition can be added for their month, and that gets
   * harder the longer nobody looks.
   */
  failed: number;
  skipped?: "no-privileged-client";
}

@Injectable()
export class AuditPartitionService {
  private readonly logger = new Logger("AuditPartition");

  constructor(private readonly privileged: PrivilegedDatabaseService) {}

  /** Ensure partitions exist for the current month and the next N months. */
  /**
   * EVERY partitioned table, not just the audit log.
   *
   * `attendance_record` joined it — the largest table in the product, and one
   * whose partitions must exist BEFORE a register is taken, since a school
   * marks attendance every working morning. A table whose extender stops is a
   * bug with a start date, and the DEFAULT partition is what makes that quiet:
   * inserts keep working and the rows pile up somewhere they must later be
   * migrated out of. Both are checked, and both count into `failed`.
   */
  private static readonly PARTITIONED = [
    { fn: "ensure_audit_log_partition", table: "audit_log" },
    { fn: "ensure_attendance_record_partition", table: "attendance_record" },
  ] as const;

  async ensureUpcoming(monthsAhead = AUDIT_PARTITION_MONTHS_AHEAD): Promise<AuditPartitionResult> {
    const client = this.privileged.client;
    if (!client) {
      this.logger.warn("No privileged DB client — partition maintenance DISABLED (no-op).");
      return { ensured: [], defaultRows: 0, failed: 0, skipped: "no-privileged-client" };
    }

    const ensured: string[] = [];
    let defaultRows = 0;
    const now = new Date();

    for (const { fn, table } of AuditPartitionService.PARTITIONED) {
      for (let i = 0; i <= monthsAhead; i++) {
        // First of the target month, in UTC (partition bounds are month boundaries).
        const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
        const iso = month.toISOString().slice(0, 10);
        const rows = await client.$queryRawUnsafe<Array<Record<string, string>>>(
          `SELECT ${fn}($1::date)`,
          iso,
        );
        const name = rows[0]?.[fn];
        if (name) ensured.push(name);
      }

      // The DEFAULT partition must stay empty; anything in it means a month was
      // missed. Counted per table and summed, so one healthy table cannot hide
      // the other.
      const [{ count }] = await client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM "${table}_default"`,
      );
      const n = Number(count);
      defaultRows += n;
      if (n > 0) {
        this.logger.error(
          `${table}_default holds ${n} row(s) — a month was not pre-created. ` +
            "Those rows must be migrated into a real partition before one can be added for their month.",
        );
      }
    }

    this.logger.log(`Partitions ensured: ${ensured.join(", ")} (default rows: ${defaultRows}).`);
    return { ensured, defaultRows, failed: defaultRows };
  }
}
