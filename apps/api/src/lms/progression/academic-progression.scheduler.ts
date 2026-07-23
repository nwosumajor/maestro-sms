import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  ACADEMIC_PROGRESSION_QUEUE,
  ADVANCE_TERMS_JOB,
  DEFAULT_PROGRESSION_CRON,
  PROGRESSION_SCHEDULER_ID,
} from "./academic-progression.constants";

/**
 * Registers the daily auto-progression sweep as a BullMQ repeatable job. Keyed
 * by a stable id so re-registration on every boot is idempotent. Schedule
 * overridable via ACADEMIC_PROGRESSION_CRON.
 */
@Injectable()
export class AcademicProgressionScheduler implements OnModuleInit {
  private readonly logger = new Logger("AcademicProgressionScheduler");

  constructor(@InjectQueue(ACADEMIC_PROGRESSION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.ACADEMIC_PROGRESSION_CRON ?? DEFAULT_PROGRESSION_CRON;
    await this.queue.add(
      ADVANCE_TERMS_JOB,
      {},
      { repeat: { pattern }, jobId: PROGRESSION_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Progression sweep scheduled: "${pattern}" (job ${PROGRESSION_SCHEDULER_ID}).`);
  }
}
