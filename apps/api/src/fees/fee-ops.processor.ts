import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { FEE_OPS_QUEUE, FeeOpsService, LATE_FEE_JOB, REMINDER_JOB } from "./fee-ops.service";

/** BullMQ worker for the fee-ops sweeps. Cross-tenant by design (privileged
 *  school list inside the service) — same posture as dunning/reconciliation. */
@Processor(FEE_OPS_QUEUE)
export class FeeOpsProcessor extends WorkerHost {
  private readonly logger = new Logger(FeeOpsProcessor.name);

  constructor(private readonly feeOps: FeeOpsService) {
    super();
  }

  async process(job: Job): Promise<Record<string, number>> {
    if (job.name === LATE_FEE_JOB) {
      const r = await this.feeOps.lateFeeSweep();
      this.logger.log(`Late-fee sweep done: schools=${r.schools} applied=${r.feesApplied}`);
      return r;
    }
    if (job.name === REMINDER_JOB) {
      const r = await this.feeOps.reminderSweep();
      this.logger.log(`Reminder sweep done: schools=${r.schools} reminded=${r.reminded}`);
      return r;
    }
    return {};
  }
}
