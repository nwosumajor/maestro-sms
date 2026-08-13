import { Processor, WorkerHost } from "@nestjs/bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import {
  MM_RECOVERY_JOB,
  MM_RECOVERY_QUEUE,
  MobileMoneyService,
  type MobileMoneyRecoveryResult,
} from "./mobile-money.service";

/** BullMQ worker for the mobile-money recovery sweep. Privileged inside the
 *  service (cross-tenant scan) — the same posture as dunning and reconciliation. */
@Processor(MM_RECOVERY_QUEUE)
export class MobileMoneyRecoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(MobileMoneyRecoveryProcessor.name);

  constructor(private readonly mm: MobileMoneyService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<MobileMoneyRecoveryResult> {
    return this.runs.record("payments.mobileMoneyRecovery", "SCHEDULE", async () => {
      const zero = { scanned: 0, settled: 0, failed: 0, stillPending: 0, expired: 0 };
      if (job.name !== MM_RECOVERY_JOB) return zero;
      const r = await this.mm.recoverPending("SCHEDULED");
      // Logged at WARN when anything was recovered: a settled charge here means a
      // callback was LOST, which is worth noticing even though the money is now right.
      const line = `Mobile-money recovery: scanned=${r.scanned} settled=${r.settled} failed=${r.failed} pending=${r.stillPending} expired=${r.expired}`;
      if (r.settled > 0 || r.expired > 0) this.logger.warn(line);
      else this.logger.log(line);
      return r;
  
    });
  }
}
