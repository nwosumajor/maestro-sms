import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_SIS_NUDGE_CRON,
  SIS_NUDGE_QUEUE,
  SIS_NUDGE_SCHEDULER_ID,
  SIS_NUDGE_SWEEP_JOB,
} from "./sis.constants";

/** Registers the daily SIS profile-completion nudge as a BullMQ repeatable job
 *  (idempotent via a stable id). Override the schedule with SIS_NUDGE_CRON.
 *  Mirrors the HR reminder / billing dunning schedulers. */
@Injectable()
export class SisNudgeScheduler implements OnModuleInit {
  private readonly logger = new Logger("SisNudgeScheduler");

  constructor(@InjectQueue(SIS_NUDGE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.SIS_NUDGE_CRON ?? DEFAULT_SIS_NUDGE_CRON;
    await this.queue.add(
      SIS_NUDGE_SWEEP_JOB,
      {},
      { repeat: { pattern }, jobId: SIS_NUDGE_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`SIS profile nudge scheduled: "${pattern}" (job ${SIS_NUDGE_SCHEDULER_ID}).`);
  }
}
