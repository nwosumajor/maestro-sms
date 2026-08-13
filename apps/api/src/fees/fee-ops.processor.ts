import { Processor, WorkerHost } from "@nestjs/bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { FEE_OPS_QUEUE, FeeOpsService, LATE_FEE_JOB, REMINDER_JOB } from "./fee-ops.service";

/** BullMQ worker for the fee-ops sweeps. Cross-tenant by design (privileged
 *  school list inside the service) — same posture as dunning/reconciliation. */
@Processor(FEE_OPS_QUEUE)
export class FeeOpsProcessor extends WorkerHost {
  private readonly logger = new Logger(FeeOpsProcessor.name);

  constructor(private readonly feeOps: FeeOpsService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<Record<string, number>> {
    return this.runs.record("fees.ops", "SCHEDULE", async (): Promise<Record<string, number>> => {
      // "done: schools=0" and "never ran" must not read the same. The service
      // flags the difference; this reports it.
      if (job.name === LATE_FEE_JOB) {
        const r = await this.feeOps.lateFeeSweep();
        this.logger.log(
          r.skipped
            ? "Late-fee sweep SKIPPED (no privileged DB) — this is not a sweep that found nothing overdue."
            : `Late-fee sweep done: schools=${r.schools} applied=${r.feesApplied}`,
        );
        return { schools: r.schools, feesApplied: r.feesApplied };
      }
      if (job.name === REMINDER_JOB) {
        const r = await this.feeOps.reminderSweep();
        this.logger.log(
          r.skipped
            ? "Overdue-reminder sweep SKIPPED (no privileged DB) — this is not a sweep that found nothing to chase."
            : `Reminder sweep done: schools=${r.schools} reminded=${r.reminded}`,
        );
        return { schools: r.schools, reminded: r.reminded };
      }
      return {};
  
    });
  }
}
