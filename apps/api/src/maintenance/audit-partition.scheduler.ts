import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  AUDIT_PARTITION_JOB,
  AUDIT_PARTITION_QUEUE,
  AUDIT_PARTITION_SCHEDULER_ID,
  DEFAULT_AUDIT_PARTITION_CRON,
} from "./maintenance.constants";

/**
 * Registers the daily audit_log partition sweep as a BullMQ repeatable job. Keyed
 * by a stable id so re-registration on every boot is idempotent. Schedule
 * overridable via AUDIT_PARTITION_CRON. (Mirrors the dunning / retention schedulers.)
 */
@Injectable()
export class AuditPartitionScheduler implements OnModuleInit {
  private readonly logger = new Logger("AuditPartitionScheduler");

  constructor(@InjectQueue(AUDIT_PARTITION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.AUDIT_PARTITION_CRON ?? DEFAULT_AUDIT_PARTITION_CRON;
    await this.queue.add(
      AUDIT_PARTITION_JOB,
      {},
      { repeat: { pattern }, jobId: AUDIT_PARTITION_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Audit partition sweep scheduled: "${pattern}" (job ${AUDIT_PARTITION_SCHEDULER_ID}).`);
  }
}
