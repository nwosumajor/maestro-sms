import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_TERM_ARCHIVE_CRON,
  TERM_ARCHIVE_JOB,
  TERM_ARCHIVE_QUEUE,
  TERM_ARCHIVE_SCHEDULER_ID,
} from "./archive.service";
import { pruneStaleRepeatables } from "../common/repeatable";

/** Registers the daily term-boundary archive (idempotent by stable job id;
 *  overridable via TERM_ARCHIVE_CRON). Mirrors the retention scheduler. */
@Injectable()
export class TermArchiveScheduler implements OnModuleInit {
  private readonly logger = new Logger("TermArchiveScheduler");

  constructor(@InjectQueue(TERM_ARCHIVE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.TERM_ARCHIVE_CRON ?? DEFAULT_TERM_ARCHIVE_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis forever.
    await pruneStaleRepeatables(this.queue, TERM_ARCHIVE_JOB, [pattern], this.logger);
    await this.queue.add(
      TERM_ARCHIVE_JOB,
      {},
      { repeat: { pattern }, jobId: TERM_ARCHIVE_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Term archive scheduled: "${pattern}" (job ${TERM_ARCHIVE_SCHEDULER_ID}).`);
  }
}
