import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_RETENTION_CRON,
  INTEGRITY_RETENTION_QUEUE,
  PURGE_EXPIRED_JOB,
  RETENTION_SCHEDULER_ID,
} from "../integrity.constants";

/**
 * Registers the daily retention sweep as a BullMQ repeatable job. Keyed by a
 * stable id so re-registration on every boot is idempotent (no duplicate
 * schedules). Schedule overridable via INTEGRITY_RETENTION_CRON.
 */
@Injectable()
export class IntegrityRetentionScheduler implements OnModuleInit {
  private readonly logger = new Logger("IntegrityRetentionScheduler");

  constructor(
    @InjectQueue(INTEGRITY_RETENTION_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.INTEGRITY_RETENTION_CRON ?? DEFAULT_RETENTION_CRON;
    await this.queue.add(
      PURGE_EXPIRED_JOB,
      {},
      {
        repeat: { pattern },
        jobId: RETENTION_SCHEDULER_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    this.logger.log(
      `Retention sweep scheduled: "${pattern}" (job ${RETENTION_SCHEDULER_ID}).`,
    );
  }
}
