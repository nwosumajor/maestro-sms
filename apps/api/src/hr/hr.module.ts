import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { WorkflowModule } from "../workflow/workflow.module";
import { NotificationModule } from "../notifications/notification.module";
import { HrController } from "./hr.controller";
import { HrService } from "./hr.service";
import { LeaveController } from "./leave.controller";
import { LeaveService } from "./leave.service";
import { SalaryController } from "./salary.controller";
import { SalaryService } from "./salary.service";
import { PayrollController } from "./payroll.controller";
import { PayrollService } from "./payroll.service";
import { StaffLifecycleController } from "./staff-lifecycle.controller";
import { StaffLifecycleService } from "./staff-lifecycle.service";
import { HrReviewsController } from "./reviews.controller";
import { HrReviewsService } from "./reviews.service";
import { HrAnalyticsController } from "./analytics.controller";
import { HrAnalyticsService } from "./analytics.service";
import { RecruitmentController } from "./recruitment.controller";
import { RecruitmentService } from "./recruitment.service";
import { HR_REMINDER_DATABASE, HR_REMINDER_QUEUE } from "./hr.constants";
import { HrReminderDatabaseService } from "./hr-reminder-database.service";
import { StaffReminderService } from "./staff-reminder.service";
import { StaffReminderScheduler } from "./staff-reminder.scheduler";
import { StaffReminderProcessor } from "./staff-reminder.processor";

@Module({
  imports: [WorkflowModule, NotificationModule, BullModule.registerQueue({ name: HR_REMINDER_QUEUE })],
  controllers: [
    HrController,
    LeaveController,
    SalaryController,
    PayrollController,
    StaffLifecycleController,
    HrReviewsController,
    HrAnalyticsController,
    RecruitmentController,
  ],
  providers: [
    HrService,
    LeaveService,
    SalaryService,
    PayrollService,
    StaffLifecycleService,
    HrReviewsService,
    HrAnalyticsService,
    RecruitmentService,
    StaffReminderService,
    StaffReminderScheduler,
    StaffReminderProcessor,
    { provide: HR_REMINDER_DATABASE, useClass: HrReminderDatabaseService },
  ],
  exports: [HrService, LeaveService, SalaryService, PayrollService, StaffLifecycleService, HrReviewsService],
})
export class HrModule {}
