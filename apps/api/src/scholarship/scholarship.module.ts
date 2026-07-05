import { Module } from "@nestjs/common";
import { NotificationModule } from "../notifications/notification.module";
import { ScholarshipController } from "./scholarship.controller";
import { ScholarshipService } from "./scholarship.service";
import { ScholarshipAdminService } from "./scholarship-admin.service";

// TENANT_DATABASE / AUDIT_LOG_SERVICE and PrivilegedDatabaseService are provided
// by global modules; only Notifications needs importing here.
@Module({
  imports: [NotificationModule],
  controllers: [ScholarshipController],
  providers: [ScholarshipService, ScholarshipAdminService],
  exports: [ScholarshipService, ScholarshipAdminService],
})
export class ScholarshipModule {}
