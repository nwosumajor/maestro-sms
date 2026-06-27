import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  BILLING_DUNNING_QUEUE,
  DEFAULT_DUNNING_CRON,
  DUNNING_SCHEDULER_ID,
  DUNNING_SWEEP_JOB,
} from "./billing.constants";

/**
 * Registers the daily dunning sweep as a BullMQ repeatable job. Keyed by a stable
 * id so re-registration on every boot is idempotent. Schedule overridable via
 * BILLING_DUNNING_CRON. (Mirrors the integrity retention scheduler.)
 */
@Injectable()
export class BillingDunningScheduler implements OnModuleInit {
  private readonly logger = new Logger("BillingDunningScheduler");

  constructor(@InjectQueue(BILLING_DUNNING_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.BILLING_DUNNING_CRON ?? DEFAULT_DUNNING_CRON;
    await this.queue.add(
      DUNNING_SWEEP_JOB,
      {},
      { repeat: { pattern }, jobId: DUNNING_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Dunning sweep scheduled: "${pattern}" (job ${DUNNING_SCHEDULER_ID}).`);
  }
}
