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
// VALUE import: Prisma.sql/empty only resolve as values, not types (CLAUDE.md).
import { Prisma } from "@sms/db";
import { REJECTED_SUBMISSION_RETENTION_DAYS } from "@sms/types";
import { RETENTION_DATABASE } from "../integrity/integrity.constants";
import { RetentionDatabaseService } from "../integrity/retention/retention-database.service";
import { STORAGE_PROVIDER, type StorageProvider } from "./storage.provider";

export type SubmissionRetentionResult = {
  /** Distinct declined applications this run took a file from. */
  applications: number;
  /** Files whose bytes were removed. */
  filesPurged: number;
  /** Rows that kept their history but lost their file. */
  rowsCleared: number;
  /** Objects the store would not give up. Left for the next run rather than
   *  orphaned — see the ordering note below. */
  failed: number;
  /** Files still held for declined applications that this run did not reach,
   *  because the batch is capped — see `JobStatus.lastBacklog`. Unlike the
   *  application-shaped count this replaced, it falls as work is done. */
  backlog: number;
  skipped?: boolean;
};

/** Files cleared per run. The unit is the FILE, not the application: a cap on
 *  applications could never advance, because clearing a file does not change
 *  the application it belongs to. */
export const RETENTION_BATCH = 500;

const EMPTY: SubmissionRetentionResult = { applications: 0, filesPurged: 0, rowsCleared: 0, failed: 0, backlog: 0 };

@Injectable()
export class SubmissionRetentionService {
  private readonly logger = new Logger("SubmissionRetention");

  constructor(
    @Inject(RETENTION_DATABASE) private readonly db: RetentionDatabaseService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * @param onlySchoolId one school, when its own privacy officer pressed it.
   * `privacy.compliance.manage` is a per-school permission, and this purged the
   * fleet — one school's officer deleting another school's applicants' identity
   * documents, irreversibly. The nightly run is what covers everyone.
   */
  async purgeRejected(
    trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED",
    onlySchoolId?: string,
  ): Promise<SubmissionRetentionResult> {
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

    // THE PAGE IS DRAWN FROM THE WORK, NOT FROM THE APPLICATIONS.
    //
    // This used to take the first 500 declined applications past the window and
    // clear whatever files hung off each. But the sweep's only write is to
    // `document_submission` — nothing about the APPLICATION changes when its
    // files go — so the very same 500 rows matched again the next night, and
    // the night after. Measured against a real database: run one cleared 409
    // files, runs two, three and four each reported `applications: 500,
    // filesPurged: 0`, and 191 declined families' birth certificates were still
    // held. `backlog` sat at exactly 475,036 on every run, never moving, which
    // reads as "behind and catching up" rather than "stuck for ever".
    //
    // A capped sweep only advances if taking a row REMOVES it from the
    // predicate the page is drawn from. So the unit is the FILE: every row this
    // selects is a file still held, and clearing it drops it out. The backlog
    // counted over the same predicate now genuinely falls.
    //
    // It is also one query instead of one per application. The old inner lookup
    // filtered `subjectKind`/`subjectId` with no `schoolId`, so the tenant-
    // leading index could not serve it and each of the 500 scanned the whole
    // table.
    const schoolFilter = onlySchoolId ? Prisma.sql`AND ds."schoolId" = ${onlySchoolId}::uuid` : Prisma.empty;
    const due = Prisma.sql`
      FROM document_submission ds
      JOIN admission_application a
        ON a.id = ds."subjectId" AND a."schoolId" = ds."schoolId"
      WHERE ds."subjectKind" = 'ADMISSION_APPLICATION'
        AND ds."storageKey" IS NOT NULL
        AND a.status = 'REJECTED'
        AND a."updatedAt" < ${cutoff}
        ${schoolFilter}
    `;
    // No ORDER BY, deliberately. Every row selected is a file to remove and
    // leaves the predicate once removed, so which 500 come first does not
    // affect whether the rest are ever reached — and asking for an order makes
    // the planner join the WHOLE candidate set before it can take a page:
    // measured on 40,000 held files, 180 ms ordered against 14.8 ms unordered,
    // for the same work. A row whose bytes the store refuses stays in the
    // predicate and may be picked again, which costs a slot rather than the
    // run: the loop continues past it and `failed` says how many.
    const held = (await client.$queryRaw(Prisma.sql`
      SELECT ds.id, ds."storageKey", ds."subjectId" ${due}
      LIMIT ${RETENTION_BATCH}
    `)) as Array<{ id: string; storageKey: string; subjectId: string }>;
    if (held.length === 0) return EMPTY;

    // Named once, so the COUNT and the PAGE cannot drift apart — a backlog
    // computed from a different predicate is worse than none.
    const [{ total }] = (await client.$queryRaw(
      Prisma.sql`SELECT count(*)::int AS total ${due}`,
    )) as Array<{ total: number }>;

    const result: SubmissionRetentionResult = {
      applications: new Set(held.map((h) => h.subjectId)).size,
      filesPurged: 0,
      rowsCleared: 0,
      failed: 0,
      backlog: Math.max(0, total - held.length),
    };

    for (const row of held) {
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

    if (result.filesPurged > 0 || trigger === "MANUAL") {
      this.logger.log(
        `supplied-document retention (${trigger}): ${result.filesPurged} file(s) removed across ${result.applications} declined application(s)` +
          (result.failed > 0 ? `, ${result.failed} left for the next run` : ""),
      );
    }
    return result;
  }
}
