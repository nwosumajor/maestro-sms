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
 *
 * `manual` is the endpoint that runs the job by hand, and the SCOPE matters more
 * than the path. A PLATFORM sweep is cross-tenant and privileged — running it
 * from the operator console does what the timer would have done. A SCHOOL sweep
 * runs inside ONE tenant, so pressing it from the operator console would sweep
 * the PLATFORM's own org and report "0 found" — an answer that looks like
 * success and means nothing. Those are named here so the console can say where
 * their control actually lives rather than offering a button that lies.
 */
export const SCHEDULED_JOBS = [
  {
    key: "billing.dunning",
    label: "Subscription dunning",
    everyMinutes: 1440,
    manual: { path: "billing/dunning/run", permission: "billing.dunning.run", scope: "PLATFORM" },
  },
  {
    key: "fees.reconciliation",
    label: "Payment reconciliation",
    everyMinutes: 1440,
    manual: { path: "fees/reconciliation/run", permission: "fee.reconcile.run", scope: "PLATFORM" },
  },
  {
    key: "fees.ops",
    label: "Late fees + overdue reminders",
    everyMinutes: 1440,
    // Per-school: the fees page has the button, and it bills THAT school.
    manual: { path: "fees/reminders/run", permission: "fee.manage", scope: "SCHOOL", where: "Fees → reports" },
  },
  {
    key: "payments.mobileMoneyRecovery",
    label: "Mobile-money recovery",
    everyMinutes: 60,
    manual: {
      path: "payments/mobile-money/recovery/run",
      permission: "fee.reconcile.run",
      scope: "PLATFORM",
    },
  },
  {
    key: "notifications.deliveryRecovery",
    label: "Stranded notification deliveries",
    // HOURLY (`DEFAULT_NOTIFICATION_RECOVERY_CRON` = "7 * * * *"). A delivery row
    // is only ever read by the job that performs it, so one whose job was never
    // queued is invisible for ever — an alert a school believes it sent and
    // never did. An hour, not a day: the commonest case is an absence alert.
    everyMinutes: 60,
    manual: {
      path: "notifications/deliveries/recovery/run",
      permission: "notification.send",
      scope: "PLATFORM",
    },
  },
  {
    key: "maintenance.indexBloat",
    label: "Index space reclaim",
    // WEEKLY (`DEFAULT_INDEX_BLOAT_CRON` = "10 2 * * 0"). VACUUM reclaims the
    // heap and never shrinks a btree, so every retention sweep and every
    // invoice status change leaves index pages that are kept for ever. Measured
    // on a real database: one attendance index held 409MB for 8.4MB of data.
    everyMinutes: 10080,
    manual: {
      path: "operator/maintenance/index-bloat/run",
      permission: "platform.operate",
      scope: "PLATFORM",
    },
  },
  {
    key: "payments.health",
    label: "Payment rail health",
    // DAILY at 06:15 (`DEFAULT_PAYMENT_HEALTH_CRON` = "15 6 * * *"). Declared
    // hourly when this catalogue was written, so the console called a perfectly
    // healthy job LATE every day — and a console that cries wolf is one nobody
    // reads. Found by the over-run check flagging the disagreement.
    everyMinutes: 1440,
    manual: {
      path: "operator/payment-channels/health/run",
      permission: "platform.pricing.manage",
      scope: "PLATFORM",
    },
  },
  {
    key: "hostel.exeatOverdue",
    label: "Boarders late back",
    everyMinutes: 60,
    manual: { path: "hostels/exeats/overdue/run", permission: "hostel.manage", scope: "SCHOOL", where: "Hostel" },
  },
  {
    key: "hr.staffReminders",
    label: "Staff document expiry",
    everyMinutes: 1440,
    manual: {
      path: "hr/staff/documents/reminders/run",
      permission: "hr.write",
      scope: "SCHOOL",
      where: "HR → a staff member's lifecycle panel",
    },
  },
  {
    key: "sis.nudge",
    label: "Incomplete profile nudges",
    everyMinutes: 1440,
    manual: { path: "admin/sis/nudge/run", permission: "rbac.manage", scope: "SCHOOL", where: "Admin" },
  },
  {
    key: "lms.progression",
    label: "Term / session roll-over",
    everyMinutes: 1440,
    manual: { path: "academic/progression/run", permission: "platform.operate", scope: "PLATFORM" },
  },
  {
    key: "integrity.retention",
    label: "Integrity telemetry purge",
    everyMinutes: 1440,
    manual: {
      path: "integrity/retention/run",
      permission: "integrity.retention.run",
      scope: "SCHOOL",
      where: "Admin → privacy",
    },
  },
  {
    key: "privacy.archive",
    label: "End-of-term archive sweep",
    everyMinutes: 1440,
    // Step-up gated, so it stays where the operator can re-authenticate for it.
    manual: {
      path: "privacy/archives/run-term-sweep",
      permission: "privacy.archive.manage",
      scope: "SCHOOL",
      where: "Admin → privacy",
    },
  },
  {
    // No manual endpoint: rolling a partition forward by hand outside its
    // window would create an empty future partition, so it is timer-only.
    key: "maintenance.auditPartition",
    label: "Audit-log partitioning",
    everyMinutes: 1440,
  },
  {
    key: "documents.submissionRetention",
    label: "Declined-applicant documents",
    // NIGHTLY. This is the platform letting go of a minor's identity documents
    // once the school has said no — a sweep that stops running is a privacy
    // obligation quietly going unmet, which is exactly the kind of silence this
    // catalogue exists to break.
    everyMinutes: 1440,
    manual: {
      path: "documents/retention/run",
      permission: "privacy.compliance.manage",
    },
  },
  {
    key: "operator.feedbackDigest",
    label: "Feedback digest",
    // HOURLY — `DEFAULT_FEEDBACK_DIGEST_CRON` is "0 * * * *". Declared as daily
    // when this catalogue was written, which made the console judge it against
    // 2.5 DAYS: it would have reported "OK" on a digest that had been dead since
    // the previous morning.
    everyMinutes: 60,
    manual: {
      path: "operator/feedback/digest/run",
      permission: "platform.feedback.review",
      scope: "PLATFORM",
    },
  },
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
  /** SCHEDULE-triggered runs in the last 24 hours, and how many the declared
   *  cadence implies. A hand-run is excluded: it says nothing about the timer. */
  runsInDay: number;
  expectedInDay: number;
  /** Running far MORE often than declared — the opposite failure from `overdue`,
   *  and the one this console could not see. */
  overrunning: boolean;
  /** How to run it by hand, if it can be. Absent = timer only. */
  manual?: { path: string; permission: string; scope: "PLATFORM" | "SCHOOL"; where?: string };
}

/** How far past its cadence a job may drift before the console calls it late. */
const LATE_FACTOR = 2.5;

/**
 * How many times over its declared rate a job may fire before the console says
 * so. Generous on purpose: a job whose cron is "every 5 minutes" against a
 * declared 5 will drift a run either side of the hour, and an alert that cries
 * wolf is one people turn off. The failure this exists for was THIRTY times the
 * declared rate, so a threshold of three is nowhere near it.
 */
const OVERRUN_FACTOR = 3;

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
    // A second cheap aggregate: how often each job actually fired. MANUAL runs
    // are excluded — pressing "Run now" is not evidence about the timer, and
    // counting it would make the console accuse an operator of a fault they
    // caused by asking.
    const counts = client
      ? await client.$queryRaw<Array<{ job: string; runs: bigint }>>`
          SELECT job, count(*) AS runs
          FROM job_run
          WHERE trigger = 'SCHEDULE' AND "startedAt" > now() - interval '24 hours'
          GROUP BY job
        `
      : [];
    const runsByJob = new Map(counts.map((c) => [c.job, Number(c.runs)]));
    const byJob = new Map(rows.map((r) => [r.job, r]));
    return SCHEDULED_JOBS.map((j) => {
      const last = byJob.get(j.key);
      const lateAfterMs = j.everyMinutes * 60_000 * LATE_FACTOR;
      const runsInDay = runsByJob.get(j.key) ?? 0;
      // A daily job expects 1; an hourly job 24. Rounded up so a job that fires
      // slightly off the hour is never accused on a rounding artefact.
      const expectedInDay = Math.max(1, Math.ceil(1440 / j.everyMinutes));
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
        runsInDay,
        expectedInDay,
        overrunning: runsInDay > expectedInDay * OVERRUN_FACTOR,
        ...("manual" in j
          ? { manual: (j as { manual: NonNullable<JobStatusDto["manual"]> }).manual }
          : {}),
        overdue: Boolean(last) && now - new Date(last!.startedAt).getTime() > lateAfterMs,
      };
    });
  }
}
