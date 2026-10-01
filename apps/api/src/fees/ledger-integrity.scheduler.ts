import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  DEFAULT_LEDGER_INTEGRITY_CRON,
  LEDGER_INTEGRITY_JOB,
  LEDGER_INTEGRITY_QUEUE,
  LEDGER_INTEGRITY_SCHEDULER_ID,
} from "./ledger-integrity.service";
import { pruneStaleRepeatables } from "../common/repeatable";

/** Registers the daily ledger-integrity sweep (idempotent by stable job id;
 *  schedule overridable via LEDGER_INTEGRITY_CRON). Mirrors reconciliation. */
@Injectable()
export class LedgerIntegrityScheduler implements OnModuleInit {
  private readonly logger = new Logger("LedgerIntegrityScheduler");

  constructor(@InjectQueue(LEDGER_INTEGRITY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    const pattern = process.env.LEDGER_INTEGRITY_CRON ?? DEFAULT_LEDGER_INTEGRITY_CRON;
    // Replace, do not accumulate: a changed cron would otherwise leave the old
    // schedule firing in Redis forever.
    await pruneStaleRepeatables(this.queue, LEDGER_INTEGRITY_JOB, [pattern], this.logger);
    await this.queue.add(
      LEDGER_INTEGRITY_JOB,
      {},
      { repeat: { pattern }, jobId: LEDGER_INTEGRITY_SCHEDULER_ID, removeOnComplete: true, removeOnFail: 50 },
    );
    this.logger.log(`Ledger integrity sweep scheduled: "${pattern}" (job ${LEDGER_INTEGRITY_SCHEDULER_ID}).`);
  }
}
