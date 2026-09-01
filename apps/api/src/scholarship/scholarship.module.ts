import { Module } from "@nestjs/common";
import { CbtModule } from "../cbt/cbt.module";
import { NotificationModule } from "../notifications/notification.module";
import { ScholarshipController } from "./scholarship.controller";
import { ScholarshipService } from "./scholarship.service";
import { ScholarshipAdminService } from "./scholarship-admin.service";

// TENANT_DATABASE / AUDIT_LOG_SERVICE and PrivilegedDatabaseService are provided
// by global modules; only Notifications needs importing here.
@Module({
  // Scholarship -> CBT is ONE-WAY (CBT imports branding/workflow/gradebook/
  // notifications, none of which reach scholarship), so there is no cycle.
  imports: [NotificationModule, CbtModule],
  controllers: [ScholarshipController],
  providers: [ScholarshipService, ScholarshipAdminService],
  exports: [ScholarshipService, ScholarshipAdminService],
})
export class ScholarshipModule {}
