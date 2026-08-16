import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { JobRunsService } from "../maintenance/job-runs.service";
import {
  NOTIFICATION_RECOVERY_JOB,
  NOTIFICATION_RECOVERY_QUEUE,
  NotificationRecoveryService,
  type NotificationRecoveryResult,
} from "./notification-recovery.service";

/** BullMQ worker for the stranded-delivery sweep. Cross-tenant inside the
 *  service, so it runs on the privileged client — the same posture as dunning,
 *  retention and the payment recovery sweeps. */
@Processor(NOTIFICATION_RECOVERY_QUEUE)
export class NotificationRecoveryProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationRecoveryProcessor.name);

  constructor(
    private readonly recovery: NotificationRecoveryService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  async process(job: Job): Promise<NotificationRecoveryResult> {
    return this.runs.record("notifications.deliveryRecovery", "SCHEDULE", async () => {
      const zero = { scanned: 0, requeued: 0, abandoned: 0, tooRecent: 0 };
      if (job.name !== NOTIFICATION_RECOVERY_JOB) return zero;
      return this.recovery.recoverStranded("SCHEDULED");
    });
  }
}
