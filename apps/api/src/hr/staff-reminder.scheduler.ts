import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DEFAULT_HR_REMINDER_CRON, HR_REMINDER_QUEUE, HR_REMINDER_SCHEDULER_ID, HR_REMINDER_SWEEP_JOB } from "./hr.constants";

/** Registers the daily staff-document expiry sweep as a BullMQ repeatable job
 *  (idempotent via a stable id). Override the schedule with HR_REMINDER_CRON. */
@Injectable()
export class StaffReminderScheduler implements OnModuleInit {
  private readonly logger = new Logger("StaffReminderScheduler");

  constructor(@InjectQueue(HR_REMINDER_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.HR_REMINDER_CRON ?? DEFAULT_HR_REMINDER_CRON;
    await this.queue.add(
      HR_REMINDER_SWEEP_JOB,
      {},
      { repeat: { pattern }, jobId: HR_REMINDER_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Staff reminder sweep scheduled: "${pattern}" (job ${HR_REMINDER_SCHEDULER_ID}).`);
  }
}
