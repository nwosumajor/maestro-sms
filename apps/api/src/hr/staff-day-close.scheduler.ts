import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DEFAULT_STAFF_DAY_CLOSE_CRON, STAFF_DAY_CLOSE_JOB, STAFF_DAY_CLOSE_QUEUE } from "./staff-day-close.constants";
import { pruneStaleRepeatables } from "../common/repeatable";

/** Hourly tick for the staff day-close — see StaffDayCloseService for why a
 *  once-a-day close needs an hourly sweep across a fleet of timezones. */
@Injectable()
export class StaffDayCloseScheduler implements OnModuleInit {
  private readonly logger = new Logger("StaffDayCloseScheduler");

  constructor(@InjectQueue(STAFF_DAY_CLOSE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.STAFF_DAY_CLOSE_CRON ?? DEFAULT_STAFF_DAY_CLOSE_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis for ever.
    await pruneStaleRepeatables(this.queue, STAFF_DAY_CLOSE_JOB, [pattern], this.logger);
    await this.queue.add(
      STAFF_DAY_CLOSE_JOB,
      {},
      { repeat: { pattern }, jobId: STAFF_DAY_CLOSE_JOB, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Staff day-close sweep scheduled: "${pattern}".`);
  }
}
