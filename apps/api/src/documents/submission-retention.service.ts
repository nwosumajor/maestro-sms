// =============================================================================
// Letting go of documents belonging to families the school turned down
// =============================================================================
// The admission flow invites a family to send a birth certificate before anyone
// has decided anything. That is the right trade for the ones who are accepted,
// and it means the platform ends up holding a minor's identity documents for
// every family it REJECTED. Keeping those indefinitely is the thing to avoid —
// it is the whole reason "optional at apply" needed a matching rule for letting
// go, and it is what NDPR and GDPR both expect of a controller.
//
// So: a fixed window after a rejection, the FILES go. The row stays. What was
// asked for, what arrived and what was decided remains legible; the birth
// certificate itself does not.
//
// PRIVILEGED, and necessarily so. The app role has no DELETE on
// document_submission at all (rls/110) — deliberately, so that no request path
// can be talked into removing evidence. This sweep runs on the same privileged
// client as the integrity purge and the dunning sweep, on a schedule, across
// tenants.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { REJECTED_SUBMISSION_RETENTION_DAYS } from "@sms/types";
import { RETENTION_DATABASE } from "../integrity/integrity.constants";
import { RetentionDatabaseService } from "../integrity/retention/retention-database.service";
import { STORAGE_PROVIDER, type StorageProvider } from "./storage.provider";

export type SubmissionRetentionResult = {
  /** Applications examined — rejected, and past the window. */
  applications: number;
  /** Files whose bytes were removed. */
  filesPurged: number;
  /** Rows that kept their history but lost their file. */
  rowsCleared: number;
  /** Objects the store would not give up. Left for the next run rather than
   *  orphaned — see the ordering note below. */
  failed: number;
  skipped?: boolean;
};

const EMPTY: SubmissionRetentionResult = { applications: 0, filesPurged: 0, rowsCleared: 0, failed: 0 };

@Injectable()
export class SubmissionRetentionService {
  private readonly logger = new Logger("SubmissionRetention");

  constructor(
    @Inject(RETENTION_DATABASE) private readonly db: RetentionDatabaseService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async purgeRejected(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED"): Promise<SubmissionRetentionResult> {
    const client = this.db.client;
    if (!client) {
      // SAY SO. A sweep that returns zeros in silence reads as a quiet night,
      // and this one running never would mean a school's rejected applicants'
      // documents are kept for ever while the log reports success. Every
      // sibling sweep warns here.
      this.logger.warn(
        "Supplied-document retention requested but no privileged DB — skipping. No rejected applicant's documents were removed.",
      );
      return { ...EMPTY, skipped: true };
    }

    const cutoff = new Date(Date.now() - REJECTED_SUBMISSION_RETENTION_DAYS * 86_400_000);
    // Rejected long enough ago. `updatedAt` rather than createdAt: the clock
    // starts when the school SAID NO, not when the family first applied — an
    // application that sat in review for months must not have its documents
    // vanish the day it is refused.
    const rejected = (await client.admissionApplication.findMany({
      where: { status: "REJECTED", updatedAt: { lt: cutoff } },
      select: { id: true, schoolId: true },
      take: 500,
    })) as Array<{ id: string; schoolId: string }>;
    if (rejected.length === 0) return EMPTY;

    const result: SubmissionRetentionResult = { applications: rejected.length, filesPurged: 0, rowsCleared: 0, failed: 0 };

    for (const application of rejected) {
      const withFiles = (await client.documentSubmission.findMany({
        where: { subjectKind: "ADMISSION_APPLICATION", subjectId: application.id, storageKey: { not: null } },
        select: { id: true, storageKey: true },
      })) as Array<{ id: string; storageKey: string }>;

      for (const row of withFiles) {
        // BYTES FIRST, THEN THE ROW. The row is the only record of where the
        // object lives; clearing it before the delete succeeds would leave a
        // birth certificate in the bucket that nothing can ever find again —
        // the exact opposite of what this sweep is for. A store that refuses is
        // left alone and retried on the next run.
        try {
          await this.storage.delete(row.storageKey);
        } catch (e) {
          result.failed++;
          this.logger.warn(`could not remove ${row.storageKey}: ${(e as Error).message}`);
          continue;
        }
        result.filesPurged++;
        await client.documentSubmission.update({
          where: { id: row.id },
          data: {
            storageKey: null,
            contentType: null,
            sizeBytes: null,
            // The row survives, and says why it is empty. What was asked for,
            // what arrived and what was decided stays legible.
            rejectedReason: `Removed ${REJECTED_SUBMISSION_RETENTION_DAYS} days after the application was declined.`,
          },
        });
        result.rowsCleared++;
      }
    }

    if (result.filesPurged > 0 || trigger === "MANUAL") {
      this.logger.log(
        `supplied-document retention (${trigger}): ${result.filesPurged} file(s) removed across ${result.applications} declined application(s)` +
          (result.failed > 0 ? `, ${result.failed} left for the next run` : ""),
      );
    }
    return result;
  }
}
