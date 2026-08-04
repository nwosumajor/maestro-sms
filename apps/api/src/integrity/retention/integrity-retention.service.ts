import { Inject, Injectable, Logger } from "@nestjs/common";
import { RETENTION_DATABASE } from "../integrity.constants";
import { RetentionDatabaseService } from "./retention-database.service";

export type RetentionTrigger = "SCHEDULED" | "MANUAL";

/**
 * How long a verified gateway webhook is kept.
 *
 * Its OPERATIONAL life is days — the reconciliation sweep looks back three. Its
 * EVIDENTIAL life is much longer: card schemes allow a chargeback to be raised up
 * to roughly 540 days after a transaction, and the first question in a dispute is
 * what the gateway told us and when. Two years clears that with margin.
 *
 * Not per-school, and not School-configurable: this is platform data hygiene
 * about our own delivery log, not a school's decision about its pupils.
 */
const GATEWAY_EVENT_RETENTION_DAYS = Number(process.env.GATEWAY_EVENT_RETENTION_DAYS ?? 730);
/**
 * Guesses from FINISHED games.
 *
 * The two largest tables in a ten-year deployment are attendance and game
 * guesses, and only one of them is a record anyone will ever ask for. At 50
 * schools this is on the order of 5M rows a year of pure play data; the result,
 * the placings and the leaderboard are stored separately and are what anyone
 * looks at afterwards. A year is long enough for a pupil to revisit a match and
 * far short of carrying fifty million rows through every backup.
 *
 * Only FINISHED games are touched — an in-flight game's guesses ARE the game.
 */
const GAME_GUESS_RETENTION_DAYS = Number(process.env.GAME_GUESS_RETENTION_DAYS ?? 365);
/**
 * READ notifications past the window.
 *
 * Unread is never touched at any age: an unread notice is an outstanding thing
 * to tell someone, and deleting it silently is the one outcome worse than
 * keeping it. Read ones are receipts of a conversation that already happened —
 * the invoice, the register and the report card they refer to all survive on
 * their own tables.
 */
const READ_NOTIFICATION_RETENTION_DAYS = Number(process.env.READ_NOTIFICATION_RETENTION_DAYS ?? 550);

/**
 * How many versions of a piece of LMS content are kept.
 *
 * DELIBERATELY A COUNT, NOT AN AGE. Age is the wrong bound in both directions: a
 * lesson untouched for three years would lose the only history it has, while a
 * lesson edited two hundred times this month — the actual growth risk — would
 * lose nothing at all. Capping per item bounds the worst case and matches how
 * version history is used, which is to step back through recent edits.
 */
const LMS_REVISIONS_KEPT = Number(process.env.LMS_REVISIONS_KEPT ?? 50);

export interface SchoolRetentionResult {
  schoolId: string;
  retentionDays: number;
  cutoff: string;
  signalsDeleted: number;
  draftsDeleted: number;
  telemetryDeleted: number;
  xapiDeleted: number;
  scansDeleted: number;
  /** Set when nothing was purged for a non-error reason. */
  skipped?: "DISABLED" | "NO_DB";
}

/**
 * Enforces the NDPR-aligned retention rule (Golden Rule #5): integrity TELEMETRY
 * on minors — integrity_signal / submission_draft / submission_telemetry — is
 * pruned once it is older than each school's configured window
 * (School.integrityRetentionDays). The reviewed academic record (submissions,
 * grades) is NOT touched here; only the integrity evidence/telemetry.
 *
 * Runs under the privileged retention client (see RetentionDatabaseService).
 * Every statement is explicitly scoped by schoolId, and each run writes an
 * immutable IntegrityRetentionRun record so the purge is itself auditable.
 */
@Injectable()
export class IntegrityRetentionService {
  private readonly logger = new Logger("IntegrityRetention");

  constructor(
    @Inject(RETENTION_DATABASE) private readonly db: RetentionDatabaseService,
  ) {}

  /** Sweep every tenant (the scheduled worker's entry point). */
  async purgeAllSchools(
    trigger: RetentionTrigger = "SCHEDULED",
  ): Promise<SchoolRetentionResult[]> {
    const client = this.db.client;
    if (!client) {
      this.logger.warn("Retention sweep requested but no privileged DB — skipping.");
      return [];
    }
    const schools = await client.school.findMany({
      select: { id: true, integrityRetentionDays: true },
    });
    const results: SchoolRetentionResult[] = [];
    for (const s of schools) {
      results.push(await this.purgeSchool(s.id, s.integrityRetentionDays, trigger));
    }
    // The two PLATFORM-WIDE streams, swept once rather than per school.
    //
    // gateway_event's schoolId is NULLABLE by documented design — a webhook can
    // arrive before we know which school it belongs to. A per-school loop would
    // therefore leave every unmatched event behind for ever, which is precisely
    // the set most likely to accumulate. Swept globally so the orphans go too.
    const globalCounts = await this.purgePlatformWide();

    const purged = results.reduce(
      // EVERY stream, or the reported total quietly under-counts what was purged.
      (n, r) => n + r.signalsDeleted + r.draftsDeleted + r.telemetryDeleted + r.xapiDeleted + r.scansDeleted,
      0,
    );
    this.logger.log(
      `Retention sweep (${trigger}) complete: ${schools.length} schools, ${purged} rows purged. ` +
        `Platform-wide: gatewayEvents=${globalCounts.gatewayEvents} contentRevisions=${globalCounts.contentRevisions} ` +
          `gameGuesses=${globalCounts.gameGuesses} readNotifications=${globalCounts.readNotifications}.`,
    );
    return results;
  }

  /** Purge one school using its window. schoolId/retentionDays come from the
   *  registry, never from request input. */
  async purgeSchool(
    schoolId: string,
    retentionDays: number,
    trigger: RetentionTrigger = "MANUAL",
  ): Promise<SchoolRetentionResult> {
    const client = this.db.client;
    if (!client) {
      return {
        schoolId,
        retentionDays,
        cutoff: new Date().toISOString(),
        signalsDeleted: 0,
        xapiDeleted: 0,
        scansDeleted: 0,
        draftsDeleted: 0,
        telemetryDeleted: 0,
        skipped: "NO_DB",
      };
    }
    // 0 / negative window => purging disabled for this school (keep everything).
    if (!retentionDays || retentionDays <= 0) {
      return {
        schoolId,
        retentionDays,
        cutoff: new Date().toISOString(),
        signalsDeleted: 0,
        xapiDeleted: 0,
        scansDeleted: 0,
        draftsDeleted: 0,
        telemetryDeleted: 0,
        skipped: "DISABLED",
      };
    }

    const startedAt = new Date();
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    // One transaction: delete the three append-only tables for THIS school, then
    // write the immutable run record. // SECURITY: privileged (RLS-bypassing)
    // handle, so every delete is explicitly bounded by schoolId — no cross-tenant
    // bleed even without RLS.
    const counts = await client.$transaction(async (tx) => {
      const where = { schoolId, createdAt: { lt: cutoff } };
      const signals = await tx.integritySignal.deleteMany({ where });
      const drafts = await tx.submissionDraft.deleteMany({ where });
      const telemetry = await tx.submissionTelemetry.deleteMany({ where });
      // The other two streams of behavioural telemetry about children, governed
      // by the SAME window rather than one of their own: a school that has
      // decided how long it keeps observations of its pupils has decided it for
      // all of them, and three separate dials would only ever drift apart.
      // The app role is INSERT/SELECT on both, so this sweep is the only thing
      // that can ever make them smaller.
      // NOTE the different column: an xAPI statement records when it was STORED,
      // not created — the two are not the same for a record that can arrive late.
      const xapi = await tx.xapiStatement.deleteMany({
        where: { schoolId, storedAt: { lt: cutoff } },
      });
      const scans = await tx.scanEvent.deleteMany({ where });
      await tx.integrityRetentionRun.create({
        data: {
          schoolId,
          retentionDays,
          cutoff,
          signalsDeleted: signals.count,
          draftsDeleted: drafts.count,
          telemetryDeleted: telemetry.count,
          xapiDeleted: xapi.count,
          scansDeleted: scans.count,
          trigger,
          startedAt,
        },
      });
      return { signals: signals.count, drafts: drafts.count, telemetry: telemetry.count, xapi: xapi.count, scans: scans.count };
    });

    // Counts only — never the purged evidence/content (no PII in logs).
    this.logger.log(
      `school=${schoolId} cutoff=${cutoff.toISOString()} purged ` +
        `signals=${counts.signals} drafts=${counts.drafts} telemetry=${counts.telemetry} ` +
        `xapi=${counts.xapi} scans=${counts.scans}`,
    );
    return {
      schoolId,
      retentionDays,
      cutoff: cutoff.toISOString(),
      signalsDeleted: counts.signals,
      draftsDeleted: counts.drafts,
      telemetryDeleted: counts.telemetry,
      xapiDeleted: counts.xapi,
      scansDeleted: counts.scans,
    };
  }

  /**
   * Trim the two append-only tables that are NOT about a school's pupils, and so
   * are not governed by that school's privacy window.
   *
   * Returns counts rather than writing an IntegrityRetentionRun row: that record
   * is per-school, and attributing a platform-wide delete to one school would
   * misrepresent what happened.
   */
  private async purgePlatformWide(): Promise<{
    gatewayEvents: number;
    contentRevisions: number;
    gameGuesses: number;
    readNotifications: number;
  }> {
    const client = this.db.client;
    if (!client) return { gatewayEvents: 0, contentRevisions: 0, gameGuesses: 0, readNotifications: 0 };

    const cutoff = new Date(Date.now() - GATEWAY_EVENT_RETENTION_DAYS * 86_400_000);
    // Every event past the window, INCLUDING the school-less ones.
    const events = await client.gatewayEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } });

    // Keep the newest N versions of each piece of content. One statement rather
    // than a row-by-row loop: the ranking is what makes it a per-item cap, and
    // doing it in the database keeps the whole thing to a single pass.
    const revisions = await client.$executeRaw`
      DELETE FROM lms_content_revision r
      USING (
        SELECT id, row_number() OVER (PARTITION BY "contentId" ORDER BY version DESC) AS rn
        FROM lms_content_revision
      ) ranked
      WHERE r.id = ranked.id AND ranked.rn > ${LMS_REVISIONS_KEPT}
    `;

    // Guesses from games that have FINISHED. The join is on the game's state
    // rather than the guess's age alone, because a long-running league match is
    // still live months after its first guess.
    const guessCutoff = new Date(Date.now() - GAME_GUESS_RETENTION_DAYS * 86_400_000);
    const guesses = await client.$executeRaw`
      DELETE FROM guess g
      USING game gm
      WHERE g."gameId" = gm.id
        AND gm.status = 'FINISHED'
        AND g."createdAt" < ${guessCutoff}
    `;

    // READ notifications only. An unread one is an outstanding thing to tell
    // someone and is kept at any age.
    const noteCutoff = new Date(Date.now() - READ_NOTIFICATION_RETENTION_DAYS * 86_400_000);
    const notes = await client.$executeRaw`
      DELETE FROM notification_delivery d
      USING notification n
      WHERE d."notificationId" = n.id AND n."readAt" IS NOT NULL AND n."readAt" < ${noteCutoff}
    `;
    void notes; // deliveries go first (FK); the count that matters is the parent's
    const readNotes = await client.notification.deleteMany({
      where: { readAt: { not: null, lt: noteCutoff } },
    });

    return {
      gatewayEvents: events.count,
      contentRevisions: Number(revisions),
      gameGuesses: Number(guesses),
      readNotifications: readNotes.count,
    };
  }
}