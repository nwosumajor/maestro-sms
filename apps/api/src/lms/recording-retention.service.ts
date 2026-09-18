// =============================================================================
// Letting go of a recorded lesson at the end of the year it was taught
// =============================================================================
// A class recording is footage of named children, and it is revision material
// for the year it was taught in. Keeping it after that is storage growing with
// the school's LIFETIME — the shape this codebase records as the one that
// degrades invisibly — and, more to the point, it is holding footage of minors
// for no stated purpose.
//
// So each recording is dated when it is attached (the end of the academic
// session the lesson falls in) and this sweep removes the BYTES afterwards. The
// ROW stays, carrying `recordingRemovedAt`, because "removed at the end of the
// 2025/2026 session" and "never recorded" are different facts and only one of
// them needs explaining to a pupil who came back to revise.
//
// PRIVILEGED, and necessarily so: it crosses tenants, and the app role has no
// business deleting another school's objects. Same posture as the declined-
// applicant purge, the integrity purge and dunning.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { RETENTION_DATABASE } from "../integrity/integrity.constants";
import { RetentionDatabaseService } from "../integrity/retention/retention-database.service";
import { STORAGE_PROVIDER, type StorageProvider } from "../documents/storage.provider";
import { RECORDING_RETENTION_BATCH } from "./recording-retention.constants";

export type RecordingRetentionResult = {
  /** Recordings whose bytes were removed. */
  removed: number;
  /** Bytes reclaimed, as the rows recorded them. */
  bytesReclaimed: number;
  /** Recordings this run could not remove — the store refused. NOT `skipped`:
   *  work that was due and did not happen. */
  failed: number;
  /** Schools this run could not finish at all. One school's failure must not
   *  end the fleet's sweep, and a caught-and-logged error that increments
   *  nothing reads exactly like a clean run. */
  schoolsFailed: number;
  /** Due and not reached, because the batch is capped. Counted on the SAME
   *  predicate the page is drawn from. */
  backlog: number;
  skipped?: boolean;
};

const EMPTY: RecordingRetentionResult = { removed: 0, bytesReclaimed: 0, failed: 0, schoolsFailed: 0, backlog: 0 };

@Injectable()
export class RecordingRetentionService {
  private readonly logger = new Logger("RecordingRetention");

  constructor(
    @Inject(RETENTION_DATABASE) private readonly db: RetentionDatabaseService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * @param onlySchoolId one school, when a member of staff pressed it by hand.
   * The scheduled run covers the fleet; a school-scoped press must not reach
   * another school's recordings — the fleet-sweep-one-school-could-fire defect
   * this repo records five times over.
   */
  async purgeExpired(
    trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED",
    onlySchoolId?: string,
  ): Promise<RecordingRetentionResult> {
    const client = this.db.client;
    if (!client) {
      // SAY SO. A sweep returning zeros in silence reads as a quiet night, and
      // this one never running means recordings of children are kept
      // indefinitely while the log reports success.
      this.logger.warn(
        "Class-recording retention requested but no privileged DB — skipping. No expired recording was removed.",
      );
      return { ...EMPTY, skipped: true };
    }

    // THE PAGE IS DRAWN FROM THE WORK. Every row selected still HOLDS bytes and
    // stops matching the moment they are cleared, so each run advances — the
    // property a capped sweep needs and the one the declined-applicant purge
    // was missing for as long as it existed.
    const dueWhere = {
      recordingKey: { not: null },
      recordingExpiresAt: { lt: new Date() },
      ...(onlySchoolId ? { schoolId: onlySchoolId } : {}),
    };
    const due = (await client.lmsLiveSession.findMany({
      where: dueWhere,
      select: { id: true, schoolId: true, recordingKey: true, recordingSizeBytes: true },
      // Oldest first: a queue is worked from the front, and the oldest recording
      // is the one that has been held longest past its date.
      orderBy: { recordingExpiresAt: "asc" },
      take: RECORDING_RETENTION_BATCH,
    })) as Array<{ id: string; schoolId: string; recordingKey: string; recordingSizeBytes: number | null }>;
    if (due.length === 0) return EMPTY;

    const total = await client.lmsLiveSession.count({ where: dueWhere });
    const result: RecordingRetentionResult = {
      ...EMPTY,
      backlog: Math.max(0, total - due.length),
    };
    const schoolsSeenFailing = new Set<string>();

    for (const row of due) {
      // BYTES FIRST, THEN THE ROW. The row is the only record of where the
      // object lives; clearing it before the delete succeeds would leave a
      // lesson recording in the bucket that nothing can ever find again — the
      // exact opposite of what this sweep is for. A store that refuses is left
      // alone and retried on the next run.
      try {
        await this.storage.delete(row.recordingKey);
      } catch (e) {
        result.failed++;
        schoolsSeenFailing.add(row.schoolId);
        this.logger.warn(`school ${row.schoolId}: could not remove ${row.recordingKey}: ${(e as Error).message}`);
        continue;
      }
      // READ THE SIZE BEFORE THE WRITE. The update nulls the column, and
      // whether `row` still holds the old value afterwards depends on the
      // client handing back a fresh object rather than the one it is about to
      // mutate — which is true of Prisma and is not a thing to depend on. The
      // figure an operator reads should not turn on object identity.
      const reclaimed = row.recordingSizeBytes ?? 0;
      await client.lmsLiveSession.update({
        where: { id: row.id },
        data: {
          recordingKey: null,
          recordingSizeBytes: null,
          recordingUploadedAt: null,
          recordingExpiresAt: null,
          // The row goes on saying WHY it is empty.
          recordingRemovedAt: new Date(),
        },
      });
      result.removed++;
      result.bytesReclaimed += reclaimed;
    }
    result.schoolsFailed = schoolsSeenFailing.size;

    if (result.removed > 0 || result.failed > 0 || trigger === "MANUAL") {
      this.logger.log(
        `class-recording retention (${trigger}): ${result.removed} removed, ` +
          `${(result.bytesReclaimed / 1024 / 1024).toFixed(0)} MB reclaimed` +
          (result.failed > 0 ? `, ${result.failed} left for the next run` : "") +
          (result.backlog > 0 ? `, ${result.backlog} still due` : ""),
      );
    }
    return result;
  }
}
