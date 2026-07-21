import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_LATE_FEE_CRON,
  DEFAULT_REMINDER_CRON,
  FEE_OPS_QUEUE,
  LATE_FEE_JOB,
  LATE_FEE_SCHEDULER_ID,
  REMINDER_JOB,
  REMINDER_SCHEDULER_ID,
} from "./fee-ops.service";

/** Registers the daily late-fee sweep + weekly overdue-reminder sweep
 *  (idempotent by stable job ids; FEE_LATE_FEE_CRON / FEE_REMINDER_SWEEP_CRON
 *  override). Mirrors the dunning scheduler. */
@Injectable()
export class FeeOpsScheduler implements OnModuleInit {
  private readonly logger = new Logger("FeeOpsScheduler");

  constructor(@InjectQueue(FEE_OPS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const lateCron = process.env.FEE_LATE_FEE_CRON ?? DEFAULT_LATE_FEE_CRON;
    const remindCron = process.env.FEE_REMINDER_SWEEP_CRON ?? DEFAULT_REMINDER_CRON;
    await this.queue.add(LATE_FEE_JOB, {}, { repeat: { pattern: lateCron }, jobId: LATE_FEE_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 });
    await this.queue.add(REMINDER_JOB, {}, { repeat: { pattern: remindCron }, jobId: REMINDER_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 });
    this.logger.log(`Fee ops scheduled: late fees "${lateCron}", reminders "${remindCron}".`);
  }
}
