// =============================================================================
// NotificationProcessor — BullMQ worker for async external delivery
// =============================================================================
// Consumes deliver-notification jobs and performs the PENDING channel deliveries.
// Like the integrity worker it has no HTTP request: NotificationService.runDeliveries
// re-opens a tenant transaction from the job's schoolId, so RLS still applies to
// every statement. It runs as the least-privilege app role (not privileged).
// =============================================================================

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { DELIVER_NOTIFICATION_JOB, NOTIFICATION_QUEUE } from "./notification.constants";
import type { DeliverNotificationJob } from "./notification.constants";
import { NotificationService } from "./notification.service";

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly notifications: NotificationService) {
    super();
  }

  async process(job: Job<DeliverNotificationJob>): Promise<{ sent: number; failed: number }> {
    if (job.name !== DELIVER_NOTIFICATION_JOB) return { sent: 0, failed: 0 };
    const res = await this.notifications.runDeliveries(job.data);
    this.logger.log(
      `Delivery done notification=${job.data.notificationId} sent=${res.sent} failed=${res.failed}`,
    );
    return res;
  }
}
