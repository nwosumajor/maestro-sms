import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_PAYMENT_HEALTH_CRON,
  PAYMENT_HEALTH_JOB,
  PAYMENT_HEALTH_QUEUE,
  PAYMENT_HEALTH_SCHEDULER_ID,
} from "./payment-health.constants";

/**
 * Registers the daily payment-rail health check. Keyed by a stable job id so
 * re-registration on every boot is idempotent (mirrors dunning/retention).
 * Schedule overridable via PAYMENT_HEALTH_CRON.
 */
@Injectable()
export class PaymentHealthScheduler implements OnModuleInit {
  private readonly logger = new Logger("PaymentHealthScheduler");

  constructor(@InjectQueue(PAYMENT_HEALTH_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.PAYMENT_HEALTH_CRON ?? DEFAULT_PAYMENT_HEALTH_CRON;
    await this.queue.add(
      PAYMENT_HEALTH_JOB,
      {},
      { repeat: { pattern }, jobId: PAYMENT_HEALTH_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Payment health check scheduled: "${pattern}" (job ${PAYMENT_HEALTH_SCHEDULER_ID}).`);
  }
}
