import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { pruneStaleRepeatables } from "../common/repeatable";
import {
  DEFAULT_INDEX_BLOAT_CRON,
  INDEX_BLOAT_JOB,
  INDEX_BLOAT_QUEUE,
  INDEX_BLOAT_SCHEDULER_ID,
} from "./index-bloat.service";

/** Registers the weekly index reclaim (idempotent by stable job id; overridable
 *  via INDEX_BLOAT_CRON). Weekly rather than daily: reclaiming is I/O, and an
 *  index that has just been rebuilt has nothing to give back. */
@Injectable()
export class IndexBloatScheduler implements OnModuleInit {
  private readonly logger = new Logger("IndexBloatScheduler");

  constructor(@InjectQueue(INDEX_BLOAT_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.INDEX_BLOAT_CRON ?? DEFAULT_INDEX_BLOAT_CRON;
    await pruneStaleRepeatables(this.queue, INDEX_BLOAT_JOB, [pattern], this.logger);
    await this.queue.add(
      INDEX_BLOAT_JOB,
      {},
      { repeat: { pattern }, jobId: INDEX_BLOAT_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 20 },
    );
    this.logger.log(`Index maintenance scheduled: "${pattern}".`);
  }
}
