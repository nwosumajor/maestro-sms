// =============================================================================
// Did the background jobs actually run?
// =============================================================================
// Thirteen jobs run on timers, and every one that moves money is among them:
// dunning, payment reconciliation, mobile-money recovery, late fees. Nothing
// recorded that any of them had run. The only trace was a log line — which needs
// shell access to read and is gone on rotation.
//
// That is the failure this platform was least equipped to notice, because it
// produces no error. A scheduler that stops (a Redis flush, a deploy that drops
// the repeatable job, a worker that never boots) simply goes quiet: dunning
// stops charging, reconciliation stops recovering lost payments, the
// overdue-boarder check stops looking, and the first sign is a complaint months
// later.
//
// Recording a run is therefore not telemetry. It is the difference between "this
// swept and found nothing" and "this has not swept since March", which are the
// same silence from outside.
// =============================================================================

import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

export type JobTrigger = "SCHEDULE" | "MANUAL";

/**
 * Every scheduled job, with the cadence it is supposed to keep.
 *
 * ONE catalogue, so the console can say "this job has not run" rather than only
 * listing runs that happened — a job missing from the history because it never
 * fired looks identical to one that does not exist, unless something knows it
 * ought to be there.
 *
 * `everyMinutes` is what the console judges lateness against. Deliberately
 * generous: a daily job is not in trouble at 25 hours, and an alert that cries
 * wolf is one people turn off.
 */
export const SCHEDULED_JOBS = [
  { key: "billing.dunning", label: "Subscription dunning", everyMinutes: 1440 },
  { key: "fees.reconciliation", label: "Payment reconciliation", everyMinutes: 1440 },
  { key: "fees.ops", label: "Late fees + overdue reminders", everyMinutes: 1440 },
  { key: "payments.mobileMoneyRecovery", label: "Mobile-money recovery", everyMinutes: 60 },
  { key: "payments.health", label: "Payment rail health", everyMinutes: 60 },
  { key: "hostel.exeatOverdue", label: "Boarders late back", everyMinutes: 60 },
  { key: "hr.staffReminders", label: "Staff document expiry", everyMinutes: 1440 },
  { key: "sis.nudge", label: "Incomplete profile nudges", everyMinutes: 1440 },
  { key: "lms.progression", label: "Term / session roll-over", everyMinutes: 1440 },
  { key: "integrity.retention", label: "Integrity telemetry purge", everyMinutes: 1440 },
  { key: "privacy.archive", label: "End-of-term archive sweep", everyMinutes: 1440 },
  { key: "maintenance.auditPartition", label: "Audit-log partitioning", everyMinutes: 1440 },
  { key: "operator.feedbackDigest", label: "Feedback digest", everyMinutes: 1440 },
] as const;

export type JobKey = (typeof SCHEDULED_JOBS)[number]["key"];

export interface JobStatusDto {
  key: string;
  label: string;
  everyMinutes: number;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOk: boolean | null;
  lastTrigger: string | null;
  lastSummary: unknown;
  lastError: string | null;
  /** No successful run within a generous multiple of its cadence. */
  overdue: boolean;
  /** Has never run at all — a different problem from "late". */
  neverRun: boolean;
}

/** How far past its cadence a job may drift before the console calls it late. */
const LATE_FACTOR = 2.5;

@Injectable()
export class JobRunsService {
  private readonly logger = new Logger("JobRuns");

  constructor(@Inject(PrivilegedDatabaseService) private readonly db: PrivilegedDatabaseService) {}

  /**
   * Run a job and record what happened.
   *
   * NEVER swallows the job's own failure — it records it and rethrows, so BullMQ
   * still retries and the queue's failure count stays true. And never lets a
   * recording failure break the job: if this table is unwritable the sweep must
   * still sweep, because the record exists to observe the work and not to gate it.
   */
  async record<T>(job: JobKey, trigger: JobTrigger, fn: () => Promise<T>): Promise<T> {
    const client = this.db.client;
    let id: string | null = null;
    if (client) {
      try {
        const row = await client.jobRun.create({ data: { job, trigger }, select: { id: true } });
        id = row.id;
      } catch (err) {
        this.logger.warn(`could not open a run record for ${job}: ${(err as Error).message}`);
      }
    }
    try {
      const result = await fn();
      if (client && id) {
        await client.jobRun
          .update({
            where: { id },
            // The job's own result object: "billed 0" and "0 because nothing was
            // due" are different facts, and only the summary tells them apart.
            data: { finishedAt: new Date(), ok: true, summary: (result ?? {}) as object },
          })
          .catch((err: Error) => this.logger.warn(`could not close run ${id}: ${err.message}`));
      }
      return result;
    } catch (err) {
      if (client && id) {
        await client.jobRun
          .update({
            where: { id },
            data: { finishedAt: new Date(), ok: false, error: String((err as Error).message ?? err).slice(0, 2000) },
          })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Every scheduled job and how it last went.
   *
   * Driven by the CATALOGUE, not by the history, so a job that has never run
   * appears saying exactly that. Listing only what ran would hide the one case
   * this whole table exists for.
   */
  async status(): Promise<JobStatusDto[]> {
    const client = this.db.client;
    const now = Date.now();
    // One query for the lot: the newest run per job. `DISTINCT ON` is the cheap
    // way to say that in Postgres, and the (job, startedAt) index serves it.
    const rows = client
      ? await client.$queryRaw<
          Array<{
            job: string;
            startedAt: Date;
            finishedAt: Date | null;
            ok: boolean | null;
            trigger: string;
            summary: unknown;
            error: string | null;
          }>
        >`
          SELECT DISTINCT ON (job) job, "startedAt", "finishedAt", ok, trigger, summary, error
          FROM job_run
          ORDER BY job, "startedAt" DESC
        `
      : [];
    const byJob = new Map(rows.map((r) => [r.job, r]));
    return SCHEDULED_JOBS.map((j) => {
      const last = byJob.get(j.key);
      const lateAfterMs = j.everyMinutes * 60_000 * LATE_FACTOR;
      return {
        key: j.key,
        label: j.label,
        everyMinutes: j.everyMinutes,
        lastStartedAt: last?.startedAt ?? null,
        lastFinishedAt: last?.finishedAt ?? null,
        lastOk: last?.ok ?? null,
        lastTrigger: last?.trigger ?? null,
        lastSummary: last?.summary ?? null,
        lastError: last?.error ?? null,
        neverRun: !last,
        overdue: Boolean(last) && now - new Date(last!.startedAt).getTime() > lateAfterMs,
      };
    });
  }
}
