import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { ACADEMIC_PROGRESSION_QUEUE, ADVANCE_TERMS_JOB } from "./academic-progression.constants";
import { AcademicProgressionService } from "./academic-progression.service";

/**
 * BullMQ worker for the daily auto-progression sweep. No HTTP request; the
 * cross-tenant read of schools is privileged, the per-school roll-over is
 * tenant-scoped (see AcademicProgressionService).
 */
@Processor(ACADEMIC_PROGRESSION_QUEUE)
export class AcademicProgressionProcessor extends WorkerHost {
  private readonly logger = new Logger(AcademicProgressionProcessor.name);

  constructor(private readonly progression: AcademicProgressionService) {
    super();
  }

  async process(job: Job): Promise<{ schools: number; advanced: number }> {
    if (job.name !== ADVANCE_TERMS_JOB) return { schools: 0, advanced: 0 };
    const r = await this.progression.runSweep("SCHEDULED");
    this.logger.log(`Progression sweep done: schools=${r.schools} advanced=${r.advanced}`);
    return { schools: r.schools, advanced: r.advanced };
  }
}
