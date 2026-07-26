import { Module } from "@nestjs/common";
import { FeedbackController } from "./feedback.controller";
import { FeedbackService } from "./feedback.service";
import { NotificationModule } from "../notifications/notification.module";

// TENANT_DATABASE / AUDIT_LOG_SERVICE and PrivilegedDatabaseService are provided
// by global modules (same as ScholarshipModule); only Notifications is imported.
@Module({
  imports: [NotificationModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
