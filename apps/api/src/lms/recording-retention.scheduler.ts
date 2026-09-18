import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { pruneStaleRepeatables } from "../common/repeatable";
import {
  DEFAULT_RECORDING_RETENTION_CRON,
  RECORDING_RETENTION_JOB,
  RECORDING_RETENTION_QUEUE,
  RECORDING_RETENTION_SCHEDULER_ID,
} from "./recording-retention.constants";

/** Registers the nightly recording purge as a BullMQ repeatable. Keyed by a
 *  stable id so a redeploy replaces the schedule rather than stacking another.
 *  Overridable via RECORDING_RETENTION_CRON. */
@Injectable()
export class RecordingRetentionScheduler implements OnModuleInit {
  private readonly logger = new Logger("RecordingRetentionScheduler");

  constructor(@InjectQueue(RECORDING_RETENTION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.RECORDING_RETENTION_CRON ?? DEFAULT_RECORDING_RETENTION_CRON;
    await pruneStaleRepeatables(this.queue, RECORDING_RETENTION_JOB, [pattern], this.logger);
    await this.queue.add(
      RECORDING_RETENTION_JOB,
      {},
      { repeat: { pattern }, jobId: RECORDING_RETENTION_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Class-recording purge scheduled: "${pattern}".`);
  }
}
