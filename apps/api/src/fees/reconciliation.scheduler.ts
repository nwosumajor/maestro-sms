import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_RECONCILE_CRON,
  FEE_RECONCILE_JOB,
  FEE_RECONCILE_QUEUE,
  FEE_RECONCILE_SCHEDULER_ID,
} from "./reconciliation.service";
import { pruneStaleRepeatables } from "../common/repeatable";

/** Registers the daily reconciliation sweep (idempotent by stable job id;
 *  schedule overridable via FEE_RECONCILE_CRON). Mirrors the dunning scheduler. */
@Injectable()
export class PaymentReconciliationScheduler implements OnModuleInit {
  private readonly logger = new Logger("ReconcileScheduler");

  constructor(@InjectQueue(FEE_RECONCILE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.FEE_RECONCILE_CRON ?? DEFAULT_RECONCILE_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis forever.
    await pruneStaleRepeatables(this.queue, FEE_RECONCILE_JOB, [pattern], this.logger);
    await this.queue.add(
      FEE_RECONCILE_JOB,
      {},
      { repeat: { pattern }, jobId: FEE_RECONCILE_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Reconciliation sweep scheduled: "${pattern}" (job ${FEE_RECONCILE_SCHEDULER_ID}).`);
  }
}
