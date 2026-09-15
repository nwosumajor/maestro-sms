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
 * How long a scheduled job's run history is kept.
 *
 * Nothing pruned it. Fifteen jobs, some hourly, is well over a million rows in
 * ten years — behind the operator console that reads them, and for no purpose:
 * nobody diagnoses a sweep from a run eighteen months ago.
 */
const JOB_RUN_RETENTION_DAYS = Number(process.env.JOB_RUN_RETENTION_DAYS ?? 90);
/**
 * Rows removed per statement, and the ceiling on statements per sweep.
 *
 * These windows are new, so the FIRST sweep on a mature database deletes
 * everything that has aged past them at once — potentially tens of millions of
 * rows in a single statement. That is a long transaction holding locks, a WAL
 * burst, and replication lag; and if it fails part-way it rolls back entirely
 * and retries the same enormous delete the next night, forever.
 *
 * Batching turns that into a bounded amount of work per night. The ceiling means
 * a first sweep may take several nights to catch up, which is the correct
 * trade: nothing here is urgent, and a purge that cannot finish is worse than
 * one that takes a week.
 */
const PURGE_BATCH_ROWS = Number(process.env.PURGE_BATCH_ROWS ?? 20_000);
const PURGE_MAX_BATCHES = Number(process.env.PURGE_MAX_BATCHES ?? 25);

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

/** What a whole sweep did. `purged` counts EVERY stream — tenant-scoped and
 *  platform-wide — so no caller has to add them up and get it wrong. */
export interface RetentionSweepResult {
  schools: SchoolRetentionResult[];
  /** Schools whose purge threw. Their data is still past its window. */
  failed: number;
  purged: number;
  platformWide: { gatewayEvents: number; contentRevisions: number; gameGuesses: number; readNotifications: number; jobRuns: number };
  /** True when no privileged DB was configured — NOT the same as "nothing to purge". */
  skipped: boolean;
}

const EMPTY_PLATFORM_COUNTS = { gatewayEvents: 0, contentRevisions: 0, gameGuesses: 0, readNotifications: 0, jobRuns: 0 };

export interface SchoolRetentionResult {
  schoolId: string;
  retentionDays: number;
  cutoff: string;
  signalsDeleted: number;
  draftsDeleted: number;
  telemetryDeleted: number;
  xapiDeleted: number;
  scansDeleted: number;
  /** Raw staff clock scans, purged on their OWN window (see below). */
  staffEventsDeleted: number;
  staffEventRetentionDays: number;
  /** Set when the TELEMETRY streams were not purged for a non-error reason. The
   *  staff stream has its own window and is reported separately, because one
   *  being disabled says nothing about the other. */
  skipped?: "DISABLED" | "NO_DB";
  staffEventsSkipped?: "DISABLED" | "NO_DB";
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

  /**
   * Sweep every tenant (the scheduled worker's entry point).
   *
   * RETURNS ITS OWN TOTAL. It used to hand back only the per-school rows and
   * leave each caller to add them up, and the BullMQ processor — the number an
   * operator actually reads, because it is what the job result stores — summed
   * three of the five streams. It omitted xapiDeleted and scansDeleted, and
   * scan_event is one of the largest tables the platform projects (47M rows at
   * ten years), so a night that purged millions could report `rows=0`. The
   * platform-wide streams were missing from that total too.
   *
   * The service already had a comment two methods down saying "EVERY stream, or
   * the reported total quietly under-counts what was purged" — the defect was
   * that the total was RE-DERIVED per caller rather than computed once. It now
   * is not derivable anywhere else.
   */
  async purgeAllSchools(trigger: RetentionTrigger = "SCHEDULED"): Promise<RetentionSweepResult> {
    const client = this.db.client;
    if (!client) {
      this.logger.warn("Retention sweep requested but no privileged DB — skipping.");
      return { schools: [], failed: 0, purged: 0, platformWide: EMPTY_PLATFORM_COUNTS, skipped: true };
    }
    const schools = await client.school.findMany({
      select: { id: true, integrityRetentionDays: true, staffAttendanceEventRetentionDays: true },
    });
    const results: SchoolRetentionResult[] = [];
    // ONE SCHOOL'S FAILURE MUST NOT END THE FLEET'S SWEEP.
    //
    // Unguarded, a single school's purge throwing abandoned every school after
    // it AND the platform-wide streams below — and it would fail the same way
    // every night, so minors' telemetry would sit past its retention window
    // indefinitely, which is the one thing this job exists to prevent. The
    // late-fee sweep and the attendance rollup already work this way; this did
    // not.
    //
    // The failure is COUNTED and RETURNED, not just logged: the job-runs
    // catalogue is what an operator reads, and a sweep that reports success
    // while skipping four schools is worse than one that fails loudly.
    let failed = 0;
    for (const s of schools) {
      try {
        results.push(
          await this.purgeSchool(s.id, s.integrityRetentionDays, trigger, s.staffAttendanceEventRetentionDays),
        );
      } catch (err) {
        failed += 1;
        this.logger.error(
          `retention purge failed for school ${s.id} — its telemetry is still past its window: ${(err as Error).message}`,
        );
      }
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
      // staffEventsDeleted is the largest of them by a wide margin, and omitting
      // it is exactly how this total under-reported millions once before.
      (n, r) =>
        n + r.signalsDeleted + r.draftsDeleted + r.telemetryDeleted + r.xapiDeleted + r.scansDeleted + r.staffEventsDeleted,
      0,
    );
    const platformTotal =
      globalCounts.gatewayEvents + globalCounts.contentRevisions + globalCounts.gameGuesses + globalCounts.readNotifications + globalCounts.jobRuns;
    this.logger.log(
      `Retention sweep (${trigger}) complete: ${schools.length} schools, ${failed} failed, ${purged + platformTotal} rows purged ` +
        `(${purged} tenant-scoped + ${platformTotal} platform-wide). ` +
        `Platform-wide: gatewayEvents=${globalCounts.gatewayEvents} contentRevisions=${globalCounts.contentRevisions} ` +
          `gameGuesses=${globalCounts.gameGuesses} readNotifications=${globalCounts.readNotifications} jobRuns=${globalCounts.jobRuns}.`,
    );
    return { schools: results, failed, purged: purged + platformTotal, platformWide: globalCounts, skipped: false };
  }

  /**
   * Purge one school. schoolId and both windows come from the registry, never
   * from request input.
   *
   * TWO INDEPENDENT WINDOWS, and keeping them independent is the point.
   * `retentionDays` governs behavioural telemetry about MINORS;
   * `staffEventRetentionDays` governs the raw clock-in/out scans of ADULT staff.
   * They answer different questions and a school may reasonably set one to
   * ninety days and the other to two years — so neither may gate the other. An
   * earlier draft of this ran the staff purge inside the telemetry window's
   * early return, which meant a school disabling pupil-telemetry purging (a
   * privacy-conservative choice) silently stopped purging its staff scans too,
   * and the largest table on the platform grew for ever with nothing said.
   */
  async purgeSchool(
    schoolId: string,
    retentionDays: number,
    trigger: RetentionTrigger = "MANUAL",
    staffEventRetentionDays = 0,
  ): Promise<SchoolRetentionResult> {
    const client = this.db.client;
    const none = (
      skipped: "DISABLED" | "NO_DB" | undefined,
      staffSkipped: "DISABLED" | "NO_DB" | undefined,
    ): SchoolRetentionResult => ({
      schoolId,
      retentionDays,
      staffEventRetentionDays,
      cutoff: new Date().toISOString(),
      signalsDeleted: 0,
      xapiDeleted: 0,
      scansDeleted: 0,
      draftsDeleted: 0,
      telemetryDeleted: 0,
      staffEventsDeleted: 0,
      ...(skipped ? { skipped } : {}),
      ...(staffSkipped ? { staffEventsSkipped: staffSkipped } : {}),
    });

    if (!client) return none("NO_DB", "NO_DB");

    // 0 / negative window => purging disabled for that stream (keep everything).
    const telemetryOn = retentionDays > 0;
    const staffOn = staffEventRetentionDays > 0;
    if (!telemetryOn && !staffOn) return none("DISABLED", "DISABLED");

    const startedAt = new Date();
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    // The staff scan's own cutoff, as a CALENDAR DAY — `staff_attendance_event
    // .date` is a @db.Date holding the SCHOOL's day, not an instant, so the
    // predicate has to be a day too. At a two-year boundary a timezone's worth
    // of skew is immaterial and resolving each school's zone here would cost a
    // registry read per school for no decision it could change.
    const staffCutoff = new Date(Date.now() - staffEventRetentionDays * 86_400_000);
    staffCutoff.setUTCHours(0, 0, 0, 0);

    // THE STAFF SCANS GO FIRST, AND OUTSIDE THE TRANSACTION BELOW.
    //
    // This is the largest table the platform projects (~1.3B rows at 5,000
    // schools over five years) and these windows are new, so the FIRST sweep on
    // a mature database has years of rows to remove at once. Inside the
    // telemetry transaction that would be one enormous long-held delete; batched
    // and auto-committed it is bounded work that resumes next sweep — the same
    // reasoning, and the same helper, as the platform-wide streams.
    //
    // SECURITY: privileged (RLS-bypassing) client, so the predicate carries
    // schoolId explicitly — no cross-tenant bleed even without RLS.
    let staffEventsDeleted = 0;
    if (staffOn) {
      staffEventsDeleted = await this.deleteInBatches(
        `staff scans (school ${schoolId})`,
        (limit) => client.$executeRaw`
          DELETE FROM staff_attendance_event
          WHERE id IN (
            SELECT id FROM staff_attendance_event
            WHERE "schoolId" = ${schoolId}::uuid AND "date" < ${staffCutoff}
            LIMIT ${limit}
          )
        `,
      );
    }

    // One transaction: delete the three append-only tables for THIS school, then
    // write the immutable run record. // SECURITY: privileged (RLS-bypassing)
    // handle, so every delete is explicitly bounded by schoolId — no cross-tenant
    // bleed even without RLS.
    const counts = await client.$transaction(async (tx) => {
      const none = { count: 0 };
      const where = { schoolId, createdAt: { lt: cutoff } };
      const signals = telemetryOn ? await tx.integritySignal.deleteMany({ where }) : none;
      const drafts = telemetryOn ? await tx.submissionDraft.deleteMany({ where }) : none;
      const telemetry = telemetryOn ? await tx.submissionTelemetry.deleteMany({ where }) : none;
      // The other two streams of behavioural telemetry about children, governed
      // by the SAME window rather than one of their own: a school that has
      // decided how long it keeps observations of its pupils has decided it for
      // all of them, and three separate dials would only ever drift apart.
      // The app role is INSERT/SELECT on both, so this sweep is the only thing
      // that can ever make them smaller.
      // NOTE the different column: an xAPI statement records when it was STORED,
      // not created — the two are not the same for a record that can arrive late.
      const xapi = telemetryOn
        ? await tx.xapiStatement.deleteMany({ where: { schoolId, storedAt: { lt: cutoff } } })
        : none;
      const scans = telemetryOn ? await tx.scanEvent.deleteMany({ where }) : none;
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
          staffEventsDeleted,
          // NULL when the staff stream was not swept, which is a different fact
          // from a window of zero — the history has to be able to say which.
          staffEventRetentionDays: staffOn ? staffEventRetentionDays : null,
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
        `xapi=${counts.xapi} scans=${counts.scans} staffEvents=${staffEventsDeleted}`,
    );
    return {
      schoolId,
      retentionDays,
      staffEventRetentionDays,
      cutoff: cutoff.toISOString(),
      signalsDeleted: counts.signals,
      draftsDeleted: counts.drafts,
      telemetryDeleted: counts.telemetry,
      xapiDeleted: counts.xapi,
      scansDeleted: counts.scans,
      staffEventsDeleted,
      // Each stream reports its OWN reason for having done nothing. One being
      // disabled says nothing about the other, and a single flag would read as
      // "this school was skipped" when half of it was swept.
      ...(telemetryOn ? {} : { skipped: "DISABLED" as const }),
      ...(staffOn ? {} : { staffEventsSkipped: "DISABLED" as const }),
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
  /**
   * Run a bounded DELETE repeatedly until it stops finding rows.
   *
   * Stops at PURGE_MAX_BATCHES even when there is more to remove, and SAYS SO —
   * a sweep that quietly hits its ceiling every night for a year looks identical
   * to one with nothing left to do, and the table keeps growing while the log
   * reports success.
   */
  private async deleteInBatches(label: string, run: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < PURGE_MAX_BATCHES; i += 1) {
      const removed = Number(await run(PURGE_BATCH_ROWS));
      total += removed;
      if (removed < PURGE_BATCH_ROWS) return total;
    }
    this.logger.warn(
      `Retention: ${label} hit the ${PURGE_MAX_BATCHES}-batch ceiling (${total} removed) — more remain, ` +
        `the next sweep will continue. Raise PURGE_MAX_BATCHES to catch up faster.`,
    );
    return total;
  }

  private async purgePlatformWide(): Promise<{
    gatewayEvents: number;
    contentRevisions: number;
    gameGuesses: number;
    readNotifications: number;
    jobRuns: number;
  }> {
    const client = this.db.client;
    if (!client) return { gatewayEvents: 0, contentRevisions: 0, gameGuesses: 0, readNotifications: 0, jobRuns: 0 };

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
    const guesses = await this.deleteInBatches("guesses", (limit) => client.$executeRaw`
      DELETE FROM guess
      WHERE id IN (
        SELECT g.id FROM guess g
        JOIN game gm ON g."gameId" = gm.id
        WHERE gm.status = 'FINISHED' AND g."createdAt" < ${guessCutoff}
        LIMIT ${limit}
      )
    `);

    // READ notifications only. An unread one is an outstanding thing to tell
    // someone and is kept at any age.
    //
    // Deliveries are NOT deleted separately: notification_delivery's FK is
    // ON DELETE CASCADE, so removing the parent takes them with it. (An earlier
    // version of this cleared them first and said the other order would fail on
    // the FK — it would not, and the extra statement was doing nothing.)
    const noteCutoff = new Date(Date.now() - READ_NOTIFICATION_RETENTION_DAYS * 86_400_000);
    const readNotes = await this.deleteInBatches("read notifications", (limit) => client.$executeRaw`
      DELETE FROM notification
      WHERE id IN (
        SELECT id FROM notification
        WHERE "readAt" IS NOT NULL AND "readAt" < ${noteCutoff}
        LIMIT ${limit}
      )
    `);

    // Old job runs — but ALWAYS keeping the most recent run of each job.
    //
    // A plain age cutoff would blank the operator console for anything that
    // runs rarely: a weekly sweep that last ran outside the window would show
    // "never run", which is exactly the alarm that screen exists to raise, on a
    // job that is perfectly healthy.
    const jobCutoff = new Date(Date.now() - JOB_RUN_RETENTION_DAYS * 86_400_000);
    const jobRuns = await this.deleteInBatches("job runs", (limit) => client.$executeRaw`
      DELETE FROM job_run
      WHERE id IN (
        SELECT jr.id FROM job_run jr
        WHERE jr."startedAt" < ${jobCutoff}
          AND jr.id <> (
            SELECT latest.id FROM job_run latest
            WHERE latest.job = jr.job
            ORDER BY latest."startedAt" DESC
            LIMIT 1
          )
        LIMIT ${limit}
      )
    `);

    return {
      gatewayEvents: events.count,
      contentRevisions: Number(revisions),
      gameGuesses: guesses,
      readNotifications: readNotes,
      jobRuns,
    };
  }
}