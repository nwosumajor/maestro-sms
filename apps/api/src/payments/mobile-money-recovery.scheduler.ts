import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_MM_RECOVERY_CRON,
  MM_RECOVERY_JOB,
  MM_RECOVERY_QUEUE,
  MM_RECOVERY_SCHEDULER_ID,
} from "./mobile-money.service";
import { pruneStaleRepeatables } from "../common/repeatable";

/** Registers the hourly mobile-money recovery sweep (idempotent by stable job id;
 *  overridable via MM_RECOVERY_CRON). Mirrors the reconciliation scheduler. */
@Injectable()
export class MobileMoneyRecoveryScheduler implements OnModuleInit {
  private readonly logger = new Logger("MobileMoneyRecoveryScheduler");

  constructor(@InjectQueue(MM_RECOVERY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.MM_RECOVERY_CRON ?? DEFAULT_MM_RECOVERY_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis forever.
    await pruneStaleRepeatables(this.queue, MM_RECOVERY_JOB, [pattern], this.logger);
    await this.queue.add(
      MM_RECOVERY_JOB,
      {},
      { repeat: { pattern }, jobId: MM_RECOVERY_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Mobile-money recovery scheduled: "${pattern}" (job ${MM_RECOVERY_SCHEDULER_ID}).`);
  }
}
