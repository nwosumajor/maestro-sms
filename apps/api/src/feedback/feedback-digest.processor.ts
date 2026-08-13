// =============================================================================
// FeedbackDigestProcessor — BullMQ worker for the scheduled feedback digest
// =============================================================================
// Consumes the repeatable digest job. Like the dunning worker it has no HTTP
// request and is DELIBERATELY privileged (it must read feedback across every
// tenant to build the owner's summary). The privilege is confined to
// FeedbackService.digestSweep (via PrivilegedDatabaseService).
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { FEEDBACK_DIGEST_JOB, FEEDBACK_DIGEST_QUEUE } from "./feedback.constants";
import { FeedbackService } from "./feedback.service";

@Processor(FEEDBACK_DIGEST_QUEUE)
export class FeedbackDigestProcessor extends WorkerHost {
  private readonly logger = new Logger(FeedbackDigestProcessor.name);

  constructor(private readonly feedback: FeedbackService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<{ notified: number; newOpen: number; newReplies: number }> {
    return this.runs.record("operator.feedbackDigest", "SCHEDULE", async () => {
      if (job.name !== FEEDBACK_DIGEST_JOB) return { notified: 0, newOpen: 0, newReplies: 0 };
      const r = await this.feedback.digestSweep();
      this.logger.log(`Feedback digest done: newOpen=${r.newOpen} newReplies=${r.newReplies} notified=${r.notified}`);
      return r;
  
    });
  }
}
