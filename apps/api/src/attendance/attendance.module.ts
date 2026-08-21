import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AttendanceController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";
import { AttendanceRollupService } from "./attendance-rollup.service";
import { NotificationModule } from "../notifications/notification.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { ATTENDANCE_ROLLUP_QUEUE } from "./attendance.constants";
import { AttendanceRollupScheduler } from "./attendance-rollup.scheduler";
import { AttendanceRollupProcessor } from "./attendance-rollup.processor";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Imports NotificationModule to alert guardians on absence/lateness.
@Module({
  imports: [NotificationModule, WorkflowModule, BullModule.registerQueue({ name: ATTENDANCE_ROLLUP_QUEUE })],
  controllers: [AttendanceController],
  providers: [AttendanceService, AttendanceRollupService, AttendanceRollupScheduler, AttendanceRollupProcessor],
  exports: [AttendanceService, AttendanceRollupService],
})
export class AttendanceModule {}
