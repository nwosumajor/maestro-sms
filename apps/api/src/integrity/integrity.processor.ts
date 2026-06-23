// =============================================================================
// IntegrityProcessor — BullMQ worker
// =============================================================================
// Consumes analyze-submission jobs and runs the server detectors. The heavy /
// slow / external-call work (embeddings, shingling, similarity sweeps) lives
// here, off the request path, per CLAUDE.md ("server-side detection ... async via
// BullMQ workers").
//
// // SECURITY: the worker has NO HTTP request and therefore NO ambient tenant
// context. IntegrityService.runDetection re-opens a tenant transaction from the
// job's schoolId/userId, so RLS still applies to every statement. The worker
// never uses a privileged or non-tenant DB client.
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { ANALYZE_SUBMISSION_JOB, INTEGRITY_QUEUE } from "./integrity.constants";
import type { AnalyzeSubmissionJob } from "./integrity.constants";
import { IntegrityService } from "./integrity.service";

@Processor(INTEGRITY_QUEUE)
export class IntegrityProcessor extends WorkerHost {
  private readonly logger = new Logger(IntegrityProcessor.name);

  constructor(private readonly integrity: IntegrityService) {
    super();
  }

  async process(job: Job<AnalyzeSubmissionJob>): Promise<{ written: number }> {
    if (job.name !== ANALYZE_SUBMISSION_JOB) return { written: 0 };
    const { written } = await this.integrity.runDetection(job.data);
    // Log counts only — never the evidence or content (avoid PII in logs).
    this.logger.log(
      `Detection complete submission=${job.data.submissionId} ` +
        `trigger=${job.data.trigger} signals=${written}`,
    );
    return { written };
  }
}
