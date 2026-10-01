import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import type { LedgerIntegrityResult } from "@sms/types";
import { JobRunsService } from "../maintenance/job-runs.service";
import { LEDGER_INTEGRITY_JOB, LEDGER_INTEGRITY_QUEUE, LedgerIntegrityService } from "./ledger-integrity.service";

/** BullMQ worker for the nightly ledger-integrity sweep. Privileged and
 *  cross-tenant inside the service, like reconciliation's. */
@Processor(LEDGER_INTEGRITY_QUEUE)
export class LedgerIntegrityProcessor extends WorkerHost {
  constructor(
    private readonly integrity: LedgerIntegrityService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<LedgerIntegrityResult> {
    return this.runs.record("fees.ledgerIntegrity", "SCHEDULE", async () => {
      if (job.name !== LEDGER_INTEGRITY_JOB) {
        return { scanned: 0, mismatched: 0, paidButOwing: 0, openButSettled: 0, partialMislabelled: 0, schools: 0, failed: 0 };
      }
      // The result is RETURNED, so `failed` reaches the jobs console.
      return this.integrity.sweep("SCHEDULED");
    });
  }
}
