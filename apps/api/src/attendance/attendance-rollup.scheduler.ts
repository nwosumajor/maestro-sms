import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  ATTENDANCE_ROLLUP_JOB,
  ATTENDANCE_ROLLUP_QUEUE,
  DEFAULT_ATTENDANCE_ROLLUP_CRON,
} from "./attendance.constants";
import { pruneStaleRepeatables } from "../common/repeatable";

/**
 * The sweep the rollup was always written for and never had.
 *
 * AttendanceRollupService's own comments referred to "the daily sweep" as
 * though one existed; the only thing that ever wrote a rollup was a manual
 * endpoint no screen calls, so the table stayed empty and every attendance
 * overview took the live path.
 */
@Injectable()
export class AttendanceRollupScheduler implements OnModuleInit {
  private readonly logger = new Logger("AttendanceRollupScheduler");

  constructor(@InjectQueue(ATTENDANCE_ROLLUP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.ATTENDANCE_ROLLUP_CRON ?? DEFAULT_ATTENDANCE_ROLLUP_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis forever.
    await pruneStaleRepeatables(this.queue, ATTENDANCE_ROLLUP_JOB, [pattern], this.logger);
    await this.queue.add(
      ATTENDANCE_ROLLUP_JOB,
      {},
      { repeat: { pattern }, jobId: ATTENDANCE_ROLLUP_JOB, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Attendance rollup sweep scheduled: "${pattern}".`);
  }
}
