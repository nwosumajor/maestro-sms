// =============================================================================
// Reclaiming index space that VACUUM cannot
// =============================================================================
// The platform deletes a great deal, on purpose: the retention sweeps clear
// telemetry, read notifications, finished-game guesses, gateway events and old
// content revisions, and the money tables update repeatedly as an invoice moves
// DRAFT → ISSUED → PARTIALLY_PAID → PAID. Every one of those writes a new index
// tuple and leaves the old one dead.
//
// VACUUM reclaims the HEAP. It does not shrink a btree: freed index pages are
// kept for reuse by that index and never returned, so an index that has seen
// heavy churn stays as large as its high-water mark for ever. Nothing in this
// platform ever reindexed, which means the very mechanism that keeps the tables
// small — retention — leaves their indexes growing without bound.
//
// Measured on a real database rather than argued from theory:
//
//     attendance_record_sessionId_studentId_key   409 MB  ->  8.4 MB
//
// 98% of it was empty space, and the same database showed
// `message_credit_entry` holding 18 live rows behind 285 MB of indexes after
// 2.7 million deletes. In the latter years that is the difference between an
// index that fits in cache and one that does not.
//
// WHAT THIS IS CAREFUL ABOUT
//
//  * REINDEX CONCURRENTLY, so readers and writers are never blocked. It cannot
//    run inside a transaction, which is why every statement here is issued on
//    its own.
//  * A FAILED concurrent reindex leaves an INVALID index behind (suffix
//    `_ccnew`) that consumes space and is never used by the planner. Those are
//    swept first — without that, one interrupted run leaves rubbish that the
//    next run's own measurements would then be confused by.
//  * Only indexes big enough to be worth the I/O, and only when they are
//    disproportionate to the data they index. Reindexing a healthy index costs
//    real time and temporary disk and reclaims nothing.
//  * A bounded number per run, largest first, so a neglected database catches up
//    over several nights rather than in one enormous burst.
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

export const INDEX_BLOAT_QUEUE = "index-bloat";
export const INDEX_BLOAT_JOB = "index-bloat-reclaim";
export const INDEX_BLOAT_SCHEDULER_ID = "index-bloat-weekly";
/** Sunday 02:10. Weekly, and off-hours: this is I/O, not something to do at 9am. */
export const DEFAULT_INDEX_BLOAT_CRON = "10 2 * * 0";

/** Below this an index is not worth the I/O however bloated it is. */
export const INDEX_BLOAT_MIN_BYTES = 32 * 1024 * 1024;
/**
 * How many times its table's heap an index may be before it is suspect.
 *
 * A crude signal, deliberately: measuring true bloat needs `pgstattuple`, which
 * is an extension this platform does not require. The cases that matter are not
 * subtle — 409 MB of index over 19 MB of heap, 285 MB over 48 KB — and a
 * threshold this generous cannot mistake a table that simply has several
 * legitimate indexes for one that is rotting.
 */
export const INDEX_BLOAT_RATIO = 4;
/** Reindexed per run. A neglected database catches up over several weeks. */
export const INDEX_BLOAT_MAX_PER_RUN = 3;

export interface IndexBloatResult {
  /** Invalid leftovers from an interrupted reindex that were dropped. */
  invalidDropped: number;
  /** Indexes rebuilt this run. */
  reindexed: number;
  /** Bytes handed back to the filesystem. */
  bytesReclaimed: number;
  /** Suspect indexes this run did not get to — the next one will. */
  remaining: number;
  /** True when the sweep could not run at all — NOT a clean bill of health. */
  skipped?: "NO_DB";
  details: Array<{ index: string; table: string; beforeBytes: number; afterBytes: number }>;
}

type Candidate = { schemaname: string; indexname: string; tablename: string; idxBytes: number };

@Injectable()
export class IndexBloatService {
  private readonly logger = new Logger("IndexBloat");

  constructor(private readonly db: PrivilegedDatabaseService) {}

  async reclaim(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED"): Promise<IndexBloatResult> {
    const client = this.db.client;
    if (!client) {
      // Said out loud: a sweep that could not run and a sweep that found nothing
      // read identically in a log, and only one of them is good news.
      this.logger.warn("Index maintenance skipped: no privileged database URL configured.");
      return { invalidDropped: 0, reindexed: 0, bytesReclaimed: 0, remaining: 0, skipped: "NO_DB", details: [] };
    }

    // 1. Sweep leftovers from an interrupted REINDEX CONCURRENTLY. An invalid
    //    index is dead weight: it is maintained on every write and used by
    //    nothing.
    const invalid = (await client.$queryRawUnsafe(`
      SELECT n.nspname AS schemaname, c.relname AS indexname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND n.nspname = 'public'
    `)) as Array<{ schemaname: string; indexname: string }>;
    let invalidDropped = 0;
    for (const idx of invalid) {
      try {
        await client.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${idx.schemaname}"."${idx.indexname}"`);
        invalidDropped += 1;
      } catch (err) {
        this.logger.warn(`Could not drop invalid index ${idx.indexname}: ${String(err)}`);
      }
    }

    // 2. Find indexes that are large AND disproportionate to their table.
    const candidates = (await client.$queryRawUnsafe(
      `
      SELECT s.schemaname,
             s.indexrelname AS indexname,
             s.relname      AS tablename,
             pg_relation_size(s.indexrelid)::bigint AS "idxBytes"
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      WHERE s.schemaname = 'public'
        AND i.indisvalid
        AND pg_relation_size(s.indexrelid) >= $1
        AND pg_relation_size(s.indexrelid) > $2 * (pg_table_size(s.relid) + 1048576)
      ORDER BY pg_relation_size(s.indexrelid) DESC
    `,
      INDEX_BLOAT_MIN_BYTES,
      INDEX_BLOAT_RATIO,
    )) as Array<{ schemaname: string; indexname: string; tablename: string; idxBytes: bigint | number }>;

    const suspect: Candidate[] = candidates.map((c) => ({
      schemaname: c.schemaname,
      indexname: c.indexname,
      tablename: c.tablename,
      idxBytes: Number(c.idxBytes),
    }));

    const details: IndexBloatResult["details"] = [];
    let bytesReclaimed = 0;
    for (const c of suspect.slice(0, INDEX_BLOAT_MAX_PER_RUN)) {
      try {
        // CONCURRENTLY: no lock on the table, and it must not be inside a
        // transaction — which is why this is a bare statement rather than part
        // of an interactive tx like the rest of the platform's writes.
        await client.$executeRawUnsafe(`REINDEX INDEX CONCURRENTLY "${c.schemaname}"."${c.indexname}"`);
        const after = (await client.$queryRawUnsafe(
          `SELECT pg_relation_size($1::regclass)::bigint AS bytes`,
          `"${c.schemaname}"."${c.indexname}"`,
        )) as Array<{ bytes: bigint | number }>;
        const afterBytes = Number(after[0]?.bytes ?? c.idxBytes);
        bytesReclaimed += Math.max(0, c.idxBytes - afterBytes);
        details.push({ index: c.indexname, table: c.tablename, beforeBytes: c.idxBytes, afterBytes });
      } catch (err) {
        // One index failing must not stop the rest — and the leftover it may
        // have created is swept at the start of the next run.
        this.logger.warn(`REINDEX of ${c.indexname} failed: ${String(err)}`);
      }
    }

    const result: IndexBloatResult = {
      invalidDropped,
      reindexed: details.length,
      bytesReclaimed,
      remaining: Math.max(0, suspect.length - details.length),
      details,
    };
    const mb = (n: number) => `${Math.round((n / 1048576) * 10) / 10}MB`;
    const line =
      `Index maintenance (${trigger}): reindexed=${result.reindexed} reclaimed=${mb(bytesReclaimed)} ` +
      `invalidDropped=${invalidDropped} remaining=${result.remaining}`;
    if (result.reindexed > 0 || invalidDropped > 0) this.logger.warn(line);
    else this.logger.log(line);
    return result;
  }
}
