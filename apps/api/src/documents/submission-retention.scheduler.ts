import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { pruneStaleRepeatables } from "../common/repeatable";
import {
  DEFAULT_SUBMISSION_RETENTION_CRON,
  SUBMISSION_RETENTION_JOB,
  SUBMISSION_RETENTION_QUEUE,
  SUBMISSION_RETENTION_SCHEDULER_ID,
} from "./submission-retention.constants";

/** Registers the nightly purge as a BullMQ repeatable job. Keyed by a stable id
 *  so a redeploy replaces the schedule rather than accumulating another one.
 *  Overridable via SUBMISSION_RETENTION_CRON. */
@Injectable()
export class SubmissionRetentionScheduler implements OnModuleInit {
  private readonly logger = new Logger("SubmissionRetentionScheduler");

  constructor(@InjectQueue(SUBMISSION_RETENTION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.SUBMISSION_RETENTION_CRON ?? DEFAULT_SUBMISSION_RETENTION_CRON;
    await pruneStaleRepeatables(this.queue, SUBMISSION_RETENTION_JOB, [pattern], this.logger);
    await this.queue.add(
      SUBMISSION_RETENTION_JOB,
      {},
      { repeat: { pattern }, jobId: SUBMISSION_RETENTION_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Declined-applicant document purge scheduled: "${pattern}".`);
  }
}
