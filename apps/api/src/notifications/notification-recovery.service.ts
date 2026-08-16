// =============================================================================
// Notification recovery — deliveries nobody was ever going to look at again
// =============================================================================
// A `notification_delivery` row is created PENDING, and the ONLY code that ever
// reads a PENDING row is the BullMQ job that performs it. So if that job is
// never queued, or never runs, the row is stranded: no sweep, no retry, no
// report. The message simply never goes out, and every counter says it did.
//
// Three ways that happened, none of them exotic:
//
//   1. `queueDelivery` throws — Redis unavailable or slow — and `enqueueMany`
//      catches it, counts the recipient as created, and moves on. That path is
//      taken on the single biggest fan-out in the product (releasing an exam to
//      a class and their guardians), and its own comment says the inbox row is
//      the durable record. True; but the SMS and the email were the part the
//      family actually sees.
//   2. The queue is drained or the worker dies before the job is taken up.
//   3. The worker throws between reading the plan and recording the outcome.
//      The job has no `attempts` option, so BullMQ's default of one applies and
//      nothing retries it.
//
// This sweep is the mobile-money recovery pattern applied to the other rail that
// cannot report its own failures. It is deliberately CONSERVATIVE about what it
// re-sends:
//
//   * NEVER ATTEMPTED (attempts = 0) and older than the grace window: no
//     gateway has ever been told about this, so re-queueing it cannot duplicate
//     anything. Recovered.
//   * ATTEMPTED, still PENDING, past the give-up window: a gateway WAS told and
//     the outcome was lost. It is closed as FAILED with that stated plainly and
//     is NOT re-sent — a duplicate fee notice costs a parent's trust and a
//     second SMS credit, and we cannot tell whether the first arrived. The
//     credit reconciliation sweep is what finds the money side of this.
//
// Cross-tenant, so it runs on the privileged client like dunning, retention and
// the payment sweeps.
// =============================================================================

import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { SYSTEM_ACTOR_ID } from "../billing/billing.constants";
import {
  DELIVER_NOTIFICATION_JOB,
  NOTIFICATION_QUEUE,
  type DeliverNotificationJob,
} from "./notification.constants";

export const NOTIFICATION_RECOVERY_QUEUE = "notification-recovery";
export const NOTIFICATION_RECOVERY_JOB = "recover-notification-deliveries";
export const NOTIFICATION_RECOVERY_SCHEDULER_ID = "notification-recovery-schedule";
/** Hourly. A stranded alert about an absent child is worth an hour, not a day. */
export const DEFAULT_NOTIFICATION_RECOVERY_CRON = "7 * * * *";

/**
 * How long a PENDING row is left alone before it counts as stranded.
 *
 * Long enough that a queue simply running behind is never mistaken for a lost
 * one — the worker normally takes a row within seconds.
 */
export const STRANDED_AFTER_MINUTES = 15;
/**
 * How long an ATTEMPTED row stays open before its outcome is declared unknown.
 * A gateway that has not answered within a day is not going to.
 */
export const GIVE_UP_AFTER_HOURS = 24;
/** Rows per run. Keeps one bad night from becoming one enormous transaction. */
export const RECOVERY_BATCH = 500;

export interface NotificationRecoveryResult {
  /** PENDING rows examined. */
  scanned: number;
  /** Never-attempted rows whose delivery job was queued again. */
  requeued: number;
  /** Attempted rows closed as FAILED because their outcome cannot be known. */
  abandoned: number;
  /** Still inside the grace window — left alone, deliberately. */
  tooRecent: number;
  /** True when the sweep could not run at all — NOT a clean bill of health. */
  skipped?: "NO_DB";
}

type PendingRow = {
  id: string;
  schoolId: string;
  notificationId: string;
  attempts: number;
  createdAt: Date;
  lastAttemptAt: Date | null;
};

@Injectable()
export class NotificationRecoveryService {
  private readonly logger = new Logger("NotificationRecovery");

  constructor(
    private readonly db: PrivilegedDatabaseService,
    @Optional() @InjectQueue(NOTIFICATION_QUEUE) private readonly queue?: Queue,
  ) {}

  async recoverStranded(trigger: "SCHEDULED" | "MANUAL" = "SCHEDULED"): Promise<NotificationRecoveryResult> {
    const client = this.db.client;
    if (!client) {
      // Say so rather than returning zeros: a sweep that could not run and a
      // sweep that found nothing look identical in a log, and only one of them
      // is good news.
      this.logger.warn("Notification recovery skipped: no privileged database URL configured.");
      return { scanned: 0, requeued: 0, abandoned: 0, tooRecent: 0, skipped: "NO_DB" };
    }

    const now = Date.now();
    const strandedBefore = new Date(now - STRANDED_AFTER_MINUTES * 60_000);
    const giveUpBefore = new Date(now - GIVE_UP_AFTER_HOURS * 3_600_000);

    const pending = (await client.notificationDelivery.findMany({
      where: { status: "PENDING" },
      select: { id: true, schoolId: true, notificationId: true, attempts: true, createdAt: true, lastAttemptAt: true },
      orderBy: { createdAt: "asc" },
      take: RECOVERY_BATCH,
    })) as PendingRow[];

    const result: NotificationRecoveryResult = { scanned: pending.length, requeued: 0, abandoned: 0, tooRecent: 0 };

    // One job per NOTIFICATION, not per delivery row: the job performs every
    // pending channel for that notification, so queueing it twice would have the
    // worker do the same work twice.
    const toRequeue = new Map<string, string>();

    for (const d of pending) {
      if (d.attempts === 0) {
        if (d.createdAt > strandedBefore) {
          result.tooRecent += 1;
          continue;
        }
        toRequeue.set(d.notificationId, d.schoolId);
        continue;
      }
      // Attempted. Its outcome was lost somewhere between the gateway and the
      // recording transaction.
      const since = d.lastAttemptAt ?? d.createdAt;
      if (since > giveUpBefore) {
        result.tooRecent += 1;
        continue;
      }
      await client.notificationDelivery.update({
        where: { id: d.id },
        data: {
          status: "FAILED",
          error:
            "delivery outcome unknown — the message was handed to the provider but no result was recorded, " +
            "and it was not sent again to avoid duplicating it",
        },
      });
      result.abandoned += 1;
    }

    if (this.queue) {
      for (const [notificationId, schoolId] of toRequeue) {
        // The SYSTEM actor, not the school id. This value becomes
        // `app.current_user_id` for the delivery transaction and is what any
        // audit attributes the work to; a school id in a user id column is the
        // kind of thing that reads fine and means nothing.
        const job: DeliverNotificationJob = { schoolId, userId: SYSTEM_ACTOR_ID, notificationId };
        try {
          await this.queue.add(DELIVER_NOTIFICATION_JOB, job, { removeOnComplete: true, removeOnFail: 100 });
          result.requeued += 1;
        } catch (err) {
          // The row stays PENDING and un-attempted, so the next run tries again.
          // That is the correct outcome for a queue that is still unavailable.
          this.logger.warn(`Could not re-queue notification ${notificationId}: ${String(err)}`);
        }
      }
    } else if (toRequeue.size > 0) {
      this.logger.warn(`${toRequeue.size} stranded notifications found but no queue is configured to re-run them.`);
    }

    const line =
      `Notification recovery (${trigger}): scanned=${result.scanned} requeued=${result.requeued} ` +
      `abandoned=${result.abandoned} tooRecent=${result.tooRecent}`;
    // WARN when anything was recovered: a stranded delivery means a message a
    // school believed it had sent had not been sent, which is worth noticing
    // even now that it has gone out.
    if (result.requeued > 0 || result.abandoned > 0) this.logger.warn(line);
    else this.logger.log(line);
    return result;
  }
}
