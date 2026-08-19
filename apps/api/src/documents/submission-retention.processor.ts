import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import { SubmissionRetentionService, type SubmissionRetentionResult } from "./submission-retention.service";
import { SUBMISSION_RETENTION_JOB, SUBMISSION_RETENTION_QUEUE } from "./submission-retention.constants";

/** BullMQ worker for the declined-applicant document purge. Cross-tenant inside
 *  the service, so it runs on the privileged client — the same posture as the
 *  integrity purge, dunning and the payment recovery sweeps. */
@Processor(SUBMISSION_RETENTION_QUEUE)
export class SubmissionRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(SubmissionRetentionProcessor.name);

  constructor(
    private readonly retention: SubmissionRetentionService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<SubmissionRetentionResult> {
    return this.runs.record("documents.submissionRetention", "SCHEDULE", async () => {
      if (job.name !== SUBMISSION_RETENTION_JOB) {
        return { applications: 0, filesPurged: 0, rowsCleared: 0, failed: 0 };
      }
      const result = await this.retention.purgeRejected("SCHEDULED");
      // The number an operator reads is the one the job result stores, so it
      // must be the number that matters: files actually removed, not rows seen.
      this.logger.log(
        result.skipped
          ? "Declined-applicant documents: SKIPPED (no privileged DB)."
          : `Declined-applicant documents: ${result.filesPurged} removed, ${result.failed} deferred.`,
      );
      return result;
    });
  }
}
