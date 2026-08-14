// Registers the hourly overdue-boarder sweep as a BullMQ repeatable job.
//
// HOURLY, not daily. A daily sweep would tell a warden at 2am that a child was
// due back at 6pm — useless as an alert, and worse than none because it looks
// like coverage. The hour after they were due is the window that matters.

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { EXEAT_OVERDUE_QUEUE, EXEAT_OVERDUE_JOB, DEFAULT_EXEAT_OVERDUE_CRON } from "./hostel.constants";
import { pruneStaleRepeatables } from "../common/repeatable";

@Injectable()
export class ExeatOverdueScheduler implements OnModuleInit {
  private readonly logger = new Logger("ExeatOverdueScheduler");

  constructor(@InjectQueue(EXEAT_OVERDUE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.EXEAT_OVERDUE_CRON ?? DEFAULT_EXEAT_OVERDUE_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis forever.
    await pruneStaleRepeatables(this.queue, EXEAT_OVERDUE_JOB, [pattern], this.logger);
    await this.queue.add(
      EXEAT_OVERDUE_JOB,
      {},
      { repeat: { pattern }, jobId: EXEAT_OVERDUE_JOB, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Overdue-boarder sweep scheduled: "${pattern}".`);
  }
}
