// =============================================================================
// IntegrityRetentionProcessor — BullMQ worker for the scheduled purge sweep
// =============================================================================
// Consumes the repeatable purge-expired job and sweeps every tenant. Like the
// detection worker it has no HTTP request; unlike it, this worker is DELIBERATELY
// privileged (it must DELETE append-only telemetry the app role cannot touch).
// The privilege is confined to IntegrityRetentionService / RetentionDatabaseService.
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { INTEGRITY_RETENTION_QUEUE, PURGE_EXPIRED_JOB } from "../integrity.constants";
import { IntegrityRetentionService } from "./integrity-retention.service";

@Processor(INTEGRITY_RETENTION_QUEUE)
export class IntegrityRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(IntegrityRetentionProcessor.name);

  constructor(private readonly retention: IntegrityRetentionService) {
    super();
  }

  async process(job: Job): Promise<{ schools: number; purged: number }> {
    if (job.name !== PURGE_EXPIRED_JOB) return { schools: 0, purged: 0 };
    // Report the total the SERVICE computed. This used to re-derive it and sum
    // three of the five tenant streams, omitting xapiDeleted and scansDeleted
    // (scan_event is one of the largest tables projected) and every
    // platform-wide stream — so the job result an operator reads could say
    // rows=0 on a night that removed millions.
    const result = await this.retention.purgeAllSchools("SCHEDULED");
    this.logger.log(
      result.skipped
        ? "Purge sweep SKIPPED — no privileged DB configured. This is not a sweep that found nothing."
        : `Purge sweep done: schools=${result.schools.length} rows=${result.purged}`,
    );
    return { schools: result.schools.length, purged: result.purged };
  }
}
