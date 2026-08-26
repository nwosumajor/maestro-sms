import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import { BreachDeadlineService, type BreachDeadlineResult } from "./breach-deadline.service";
import { BREACH_DEADLINE_QUEUE, BREACH_DEADLINE_SWEEP_JOB } from "./privacy.constants";

/**
 * BullMQ worker for the hourly Art. 33 deadline sweep.
 *
 * // GOTCHA the audit-partition job taught: what the PROCESSOR returns is what
 * gets stored, and the operator's jobs console decides its "Partial" badge from
 * a numeric `failed` in that summary. Mapping the result field by field and
 * dropping `failed` on the floor renders every run healthy for ever. It is
 * returned whole.
 */
@Processor(BREACH_DEADLINE_QUEUE)
export class BreachDeadlineProcessor extends WorkerHost {
  private readonly logger = new Logger(BreachDeadlineProcessor.name);

  constructor(
    private readonly sweeper: BreachDeadlineService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<BreachDeadlineResult> {
    return this.runs.record("privacy.breachDeadline", "SCHEDULE", async () => {
      if (job.name !== BREACH_DEADLINE_SWEEP_JOB) return { scanned: 0, warned: 0, overdue: 0, failed: 0 };
      const r = await this.sweeper.sweep();
      this.logger.log(`Breach deadline done: scanned=${r.scanned} warned=${r.warned} overdue=${r.overdue}`);
      return r;
    });
  }
}
