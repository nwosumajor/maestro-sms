// =============================================================================
// StaffReminderProcessor — BullMQ worker for the daily expiry sweep
// =============================================================================
// Consumes the repeatable hr-reminder-sweep job. No HTTP request; the privilege
// is confined to StaffReminderService / HrReminderDatabaseService.
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { HR_REMINDER_QUEUE, HR_REMINDER_SWEEP_JOB } from "./hr.constants";
import { StaffReminderService } from "./staff-reminder.service";

@Processor(HR_REMINDER_QUEUE)
export class StaffReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(StaffReminderProcessor.name);

  constructor(private readonly reminders: StaffReminderService) {
    super();
  }

  async process(job: Job): Promise<{ reminded: number; scanned: number }> {
    if (job.name !== HR_REMINDER_SWEEP_JOB) return { reminded: 0, scanned: 0 };
    const r = await this.reminders.sweep();
    this.logger.log(`Staff reminder done: scanned=${r.scanned} reminded=${r.reminded}`);
    return { reminded: r.reminded, scanned: r.scanned };
  }
}
