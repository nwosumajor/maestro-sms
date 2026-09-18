import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import { RecordingRetentionService, type RecordingRetentionResult } from "./recording-retention.service";
import { RECORDING_RETENTION_JOB, RECORDING_RETENTION_QUEUE } from "./recording-retention.constants";

/** BullMQ worker for the class-recording purge. Cross-tenant inside the
 *  service, so it runs on the privileged client. */
@Processor(RECORDING_RETENTION_QUEUE)
export class RecordingRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(RecordingRetentionProcessor.name);

  constructor(
    private readonly retention: RecordingRetentionService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<RecordingRetentionResult> {
    return this.runs.record("lms.recordingRetention", "SCHEDULE", async () => {
      if (job.name !== RECORDING_RETENTION_JOB) {
        return { removed: 0, bytesReclaimed: 0, failed: 0, schoolsFailed: 0, backlog: 0 };
      }
      const result = await this.retention.purgeExpired("SCHEDULED");
      this.logger.log(
        result.skipped
          ? "Class recordings: SKIPPED (no privileged DB)."
          : `Class recordings: removed=${result.removed} failed=${result.failed} backlog=${result.backlog}`,
      );
      // `failed` is what the operator console reads as a red signal; it must be
      // the number the SERVICE produced, not re-derived here. One job in this
      // repo dropped it between the service and the processor.
      return result;
    });
  }
}
