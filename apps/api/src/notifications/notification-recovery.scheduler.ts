import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { pruneStaleRepeatables } from "../common/repeatable";
import {
  DEFAULT_NOTIFICATION_RECOVERY_CRON,
  NOTIFICATION_RECOVERY_JOB,
  NOTIFICATION_RECOVERY_QUEUE,
  NOTIFICATION_RECOVERY_SCHEDULER_ID,
} from "./notification-recovery.service";

/** Registers the hourly stranded-delivery sweep (idempotent by stable job id;
 *  overridable via NOTIFICATION_RECOVERY_CRON). Mirrors the mobile-money one. */
@Injectable()
export class NotificationRecoveryScheduler implements OnModuleInit {
  private readonly logger = new Logger("NotificationRecoveryScheduler");

  constructor(@InjectQueue(NOTIFICATION_RECOVERY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.NOTIFICATION_RECOVERY_CRON ?? DEFAULT_NOTIFICATION_RECOVERY_CRON;
    await pruneStaleRepeatables(this.queue, NOTIFICATION_RECOVERY_JOB, [pattern], this.logger);
    await this.queue.add(
      NOTIFICATION_RECOVERY_JOB,
      {},
      { repeat: { pattern }, jobId: NOTIFICATION_RECOVERY_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Notification delivery recovery scheduled: "${pattern}".`);
  }
}
