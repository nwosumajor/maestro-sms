import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { JobRunsService } from "../maintenance/job-runs.service";
import { STAFF_DAY_CLOSE_QUEUE } from "./staff-day-close.constants";
import { StaffDayCloseService } from "./staff-day-close.service";

@Processor(STAFF_DAY_CLOSE_QUEUE)
export class StaffDayCloseProcessor extends WorkerHost {
  private readonly logger = new Logger("StaffDayCloseProcessor");

  constructor(
    private readonly close: StaffDayCloseService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(): Promise<Awaited<ReturnType<StaffDayCloseService["run"]>>> {
    return this.runs.record("hr.staffDayClose", "SCHEDULE", async () => {
      const r = await this.close.run();
      // RETURNED, not only logged: `record()` files whatever the callback gives
      // it, and a `failed` dropped between a service and its processor is a
      // failure the jobs console can never show.
      this.logger.log(
        `staff day close: ${r.absent} absent, ${r.onLeave} on leave across ${r.schools} school(s)` +
          (r.openSpans ? `, ${r.openSpans} day(s) left open` : "") +
          (r.failed ? `, ${r.failed} failed` : ""),
      );
      return r;
    });
  }
}
