import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_FEEDBACK_DIGEST_CRON,
  FEEDBACK_DIGEST_JOB,
  FEEDBACK_DIGEST_QUEUE,
  FEEDBACK_DIGEST_SCHEDULER_ID,
} from "./feedback.constants";

/**
 * Registers the hourly feedback-digest sweep as a repeatable BullMQ job. Keyed
 * by a stable id so re-registration on every boot is idempotent. Schedule
 * overridable via FEEDBACK_DIGEST_CRON. (Mirrors the billing dunning scheduler.)
 */
@Injectable()
export class FeedbackDigestScheduler implements OnModuleInit {
  private readonly logger = new Logger("FeedbackDigestScheduler");

  constructor(@InjectQueue(FEEDBACK_DIGEST_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.FEEDBACK_DIGEST_CRON ?? DEFAULT_FEEDBACK_DIGEST_CRON;
    await this.queue.add(
      FEEDBACK_DIGEST_JOB,
      {},
      { repeat: { pattern }, jobId: FEEDBACK_DIGEST_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Feedback digest scheduled: "${pattern}" (job ${FEEDBACK_DIGEST_SCHEDULER_ID}).`);
  }
}
