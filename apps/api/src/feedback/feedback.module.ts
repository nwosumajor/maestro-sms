import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { FeedbackController } from "./feedback.controller";
import { FeedbackService } from "./feedback.service";
import { FeedbackDigestScheduler } from "./feedback-digest.scheduler";
import { FeedbackDigestProcessor } from "./feedback-digest.processor";
import { FEEDBACK_DIGEST_QUEUE } from "./feedback.constants";
import { NotificationModule } from "../notifications/notification.module";

// TENANT_DATABASE / AUDIT_LOG_SERVICE and PrivilegedDatabaseService are provided
// by global modules (same as ScholarshipModule); only Notifications is imported.
// The digest queue coalesces per-submission alerts into an hourly summary so the
// owner isn't buried under thousands of emails (mirrors billing dunning).
@Module({
  imports: [NotificationModule, BullModule.registerQueue({ name: FEEDBACK_DIGEST_QUEUE })],
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackDigestScheduler, FeedbackDigestProcessor],
})
export class FeedbackModule {}
