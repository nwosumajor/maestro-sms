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
import { CompensationController } from "./compensation.controller";
import { CompensationService } from "./compensation.service";
import { StaffAttendanceController, PublicBiometricController } from "./attendance.controller";
import { StaffAttendanceService } from "./attendance.service";
import { DutyController } from "./duty.controller";
import { DutyService } from "./duty.service";
import { EmploymentController } from "./employment.controller";
import { EmploymentService } from "./employment.service";
import { ExitController } from "./exit.controller";
import { ExitService } from "./exit.service";
import { LetterController } from "./letter.controller";
import { LetterService } from "./letter.service";
import { BrandingModule } from "../branding/branding.module";
import { PayrollService } from "./payroll.service";
import { StaffLifecycleController } from "./staff-lifecycle.controller";
import { StaffLifecycleService } from "./staff-lifecycle.service";
import { HrReviewsController } from "./reviews.controller";
import { HrReviewsService } from "./reviews.service";
import { HrAnalyticsController } from "./analytics.controller";
import { HrAnalyticsService } from "./analytics.service";
import { RecruitmentController, PublicCareersController } from "./recruitment.controller";
import { RecruitmentService } from "./recruitment.service";
import { HR_REMINDER_DATABASE, HR_REMINDER_QUEUE } from "./hr.constants";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { StaffReminderService } from "./staff-reminder.service";
import { StaffReminderScheduler } from "./staff-reminder.scheduler";
import { StaffReminderProcessor } from "./staff-reminder.processor";

@Module({
  imports: [WorkflowModule, NotificationModule, BrandingModule, BullModule.registerQueue({ name: HR_REMINDER_QUEUE })],
  controllers: [
    HrController,
    LeaveController,
    SalaryController,
    PayrollController,
    CompensationController,
    StaffAttendanceController,
    PublicBiometricController,
    DutyController,
    EmploymentController,
    ExitController,
    LetterController,
    StaffLifecycleController,
    HrReviewsController,
    HrAnalyticsController,
    RecruitmentController,
    PublicCareersController,
  ],
  providers: [
    HrService,
    LeaveService,
    SalaryService,
    PayrollService,
    CompensationService,
    StaffAttendanceService,
    DutyService,
    EmploymentService,
    ExitService,
    LetterService,
    StaffLifecycleService,
    HrReviewsService,
    HrAnalyticsService,
    RecruitmentService,
    StaffReminderService,
    StaffReminderScheduler,
    StaffReminderProcessor,
    { provide: HR_REMINDER_DATABASE, useExisting: PrivilegedDatabaseService },
  ],
  exports: [HrService, LeaveService, SalaryService, PayrollService, StaffLifecycleService, HrReviewsService],
})
export class HrModule {}
