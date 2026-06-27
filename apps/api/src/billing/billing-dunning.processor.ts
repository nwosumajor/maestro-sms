// =============================================================================
// BillingDunningProcessor — BullMQ worker for the scheduled dunning sweep
// =============================================================================
// Consumes the repeatable dunning-sweep job. Like the retention worker it has no
// HTTP request and is DELIBERATELY privileged (it must read every tenant's
// subscription and flip overdue ones). The privilege is confined to
// BillingDunningService / BillingDatabaseService.
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { BILLING_DUNNING_QUEUE, DUNNING_SWEEP_JOB } from "./billing.constants";
import { BillingDunningService } from "./billing-dunning.service";

@Processor(BILLING_DUNNING_QUEUE)
export class BillingDunningProcessor extends WorkerHost {
  private readonly logger = new Logger(BillingDunningProcessor.name);

  constructor(private readonly dunning: BillingDunningService) {
    super();
  }

  async process(job: Job): Promise<{ reminded: number; pastDue: number; scanned: number }> {
    if (job.name !== DUNNING_SWEEP_JOB) return { reminded: 0, pastDue: 0, scanned: 0 };
    const r = await this.dunning.sweep("SCHEDULED");
    this.logger.log(`Dunning done: scanned=${r.scanned} reminded=${r.reminded} pastDue=${r.pastDue}`);
    return { reminded: r.reminded, pastDue: r.pastDue, scanned: r.scanned };
  }
}
