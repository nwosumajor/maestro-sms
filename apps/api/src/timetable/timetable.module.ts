import { Module } from "@nestjs/common";
import { TimetableController } from "./timetable.controller";
import { TimetableService } from "./timetable.service";
import { LessonCoverService } from "./lesson-cover.service";
import { NotificationModule } from "../notifications/notification.module";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed.
@Module({
  imports: [NotificationModule],
  controllers: [TimetableController],
  providers: [TimetableService, LessonCoverService],
  exports: [TimetableService],
})
export class TimetableModule {}
