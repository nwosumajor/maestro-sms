import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { JobRunsService } from "../maintenance/job-runs.service";
import { REGISTER_REMINDER_QUEUE } from "./attendance.constants";
import { RegisterReminderService } from "./register-reminder.service";

@Processor(REGISTER_REMINDER_QUEUE)
export class RegisterReminderProcessor extends WorkerHost {
  private readonly logger = new Logger("RegisterReminderProcessor");

  constructor(
    private readonly reminder: RegisterReminderService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(): Promise<Awaited<ReturnType<RegisterReminderService["run"]>>> {
    return this.runs.record("attendance.registerReminder", "SCHEDULE", async () => {
      const r = await this.reminder.run();
      // RETURNED, not only logged — `record()` files whatever the callback gives
      // it, and `failed` dropped between a service and its processor is a
      // failure the jobs console can never show.
      this.logger.log(
        `register reminder: ${r.notified} teacher(s) told across ${r.schools} school(s)` +
          (r.unreachable ? `, ${r.unreachable} with no class teacher` : "") +
          (r.failed ? `, ${r.failed} failed` : ""),
      );
      return r;
    });
  }
}
