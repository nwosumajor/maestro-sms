import { Processor, WorkerHost } from "@nestjs/bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import { Logger } from "@nestjs/common";
import { EXEAT_OVERDUE_QUEUE } from "./hostel.constants";
import { ExeatOverdueService } from "./exeat-overdue.service";
import type { OverdueSweepResult } from "./exeat-overdue.service";

@Processor(EXEAT_OVERDUE_QUEUE)
export class ExeatOverdueProcessor extends WorkerHost {
  private readonly logger = new Logger("ExeatOverdueProcessor");

  constructor(private readonly overdue: ExeatOverdueService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(): Promise<OverdueSweepResult> {
    return this.runs.record("hostel.exeatOverdue", "SCHEDULE", async () => {
      const r = await this.overdue.sweep();
      // Reports what it FOUND and what it DID — "alerted 0" alone reads as a
      // failure; "0 of 0" and "0 of 12 already alerted" are different facts.
      this.logger.log(`overdue sweep: scanned ${r.scanned}, alerted ${r.alerted}${r.skipped ? ` (skipped: ${r.skipped})` : ""}`);
      // RETURNED, not only logged. `record()` stores whatever the callback gives
      // it, so returning nothing filed `{}` on every run — and the jobs console
      // then showed "nothing to report" for the one sweep that exists to notice
      // a child who has not come back to the boarding house. "Swept, none
      // overdue" and "found three and alerted nobody" looked identical, which is
      // the exact failure that console was built to prevent. This was the only
      // processor of the thirteen that discarded its result.
      return r;
    });
  }
}
