import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { JobRunsService } from "../maintenance/job-runs.service";
import { ATTENDANCE_ROLLUP_QUEUE } from "./attendance.constants";
import { AttendanceRollupService } from "./attendance-rollup.service";

@Processor(ATTENDANCE_ROLLUP_QUEUE)
export class AttendanceRollupProcessor extends WorkerHost {
  private readonly logger = new Logger("AttendanceRollupProcessor");

  constructor(
    private readonly rollup: AttendanceRollupService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(): Promise<{ schools: number; terms: number; skipped: number }> {
    return this.runs.record("attendance.rollup", "SCHEDULE", async () => {
      const r = await this.rollup.runSweep();
      // RETURNED, not only logged: `record()` files whatever the callback gives
      // it, and a sweep that reports nothing looks identical in the jobs console
      // to a sweep that never ran. "0 terms because there were none" and "0
      // terms because every school was skipped" are different facts, so both
      // counts go in.
      this.logger.log(
        `attendance rollup: ${r.terms} term(s) across ${r.schools} school(s)` +
          (r.skipped ? `, ${r.skipped} skipped` : ""),
      );
      return r;
    });
  }
}
