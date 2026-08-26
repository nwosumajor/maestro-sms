import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { pruneStaleRepeatables } from "../common/repeatable";
import {
  BREACH_DEADLINE_QUEUE,
  BREACH_DEADLINE_SCHEDULER_ID,
  BREACH_DEADLINE_SWEEP_JOB,
  DEFAULT_BREACH_DEADLINE_CRON,
} from "./privacy.constants";

/** Registers the hourly Art. 33 deadline sweep as a BullMQ repeatable job
 *  (idempotent via a stable id). Override with BREACH_DEADLINE_CRON. */
@Injectable()
export class BreachDeadlineScheduler implements OnModuleInit {
  private readonly logger = new Logger("BreachDeadlineScheduler");

  constructor(@InjectQueue(BREACH_DEADLINE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.BREACH_DEADLINE_CRON ?? DEFAULT_BREACH_DEADLINE_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis for ever.
    await pruneStaleRepeatables(this.queue, BREACH_DEADLINE_SWEEP_JOB, [pattern], this.logger);
    await this.queue.add(
      BREACH_DEADLINE_SWEEP_JOB,
      {},
      { repeat: { pattern }, jobId: BREACH_DEADLINE_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Breach deadline sweep scheduled: "${pattern}" (job ${BREACH_DEADLINE_SCHEDULER_ID}).`);
  }
}
