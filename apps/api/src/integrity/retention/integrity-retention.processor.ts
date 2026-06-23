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
    const results = await this.retention.purgeAllSchools("SCHEDULED");
    const purged = results.reduce(
      (n, r) => n + r.signalsDeleted + r.draftsDeleted + r.telemetryDeleted,
      0,
    );
    this.logger.log(`Purge sweep done: schools=${results.length} rows=${purged}`);
    return { schools: results.length, purged };
  }
}
