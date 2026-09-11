import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_REGISTER_REMINDER_CRON,
  REGISTER_REMINDER_JOB,
  REGISTER_REMINDER_QUEUE,
} from "./attendance.constants";
import { pruneStaleRepeatables } from "../common/repeatable";

/** Hourly tick for the daily register reminder — see RegisterReminderService
 *  for why a daily reminder needs an hourly sweep. */
@Injectable()
export class RegisterReminderScheduler implements OnModuleInit {
  private readonly logger = new Logger("RegisterReminderScheduler");

  constructor(@InjectQueue(REGISTER_REMINDER_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.REGISTER_REMINDER_CRON ?? DEFAULT_REGISTER_REMINDER_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis forever.
    await pruneStaleRepeatables(this.queue, REGISTER_REMINDER_JOB, [pattern], this.logger);
    await this.queue.add(
      REGISTER_REMINDER_JOB,
      {},
      { repeat: { pattern }, jobId: REGISTER_REMINDER_JOB, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Register reminder sweep scheduled: "${pattern}".`);
  }
}
