// =============================================================================
// SisNudgeProcessor — BullMQ worker for the daily profile-completion nudge
// =============================================================================
// Consumes the repeatable sis-nudge-sweep job. No HTTP request; the privilege is
// confined to SisNudgeService (via the shared PrivilegedDatabaseService).
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { SIS_NUDGE_QUEUE, SIS_NUDGE_SWEEP_JOB } from "./sis.constants";
import { SisNudgeService } from "./sis-nudge.service";

@Processor(SIS_NUDGE_QUEUE)
export class SisNudgeProcessor extends WorkerHost {
  private readonly logger = new Logger(SisNudgeProcessor.name);

  constructor(private readonly nudge: SisNudgeService) {
    super();
  }

  async process(job: Job): Promise<{ nudged: number; scanned: number }> {
    if (job.name !== SIS_NUDGE_SWEEP_JOB) return { nudged: 0, scanned: 0 };
    const r = await this.nudge.sweep();
    this.logger.log(`SIS nudge done: scanned=${r.scanned} nudged=${r.nudged}${r.skipped ? ` skipped=${r.skipped}` : ""}`);
    return { nudged: r.nudged, scanned: r.scanned };
  }
}
