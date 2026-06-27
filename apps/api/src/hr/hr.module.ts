import { Module } from "@nestjs/common";
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

@Module({
  // WorkflowModule gives LeaveService the engine + the finalized-hook registry;
  // NotificationModule lets the lifecycle service send expiry reminders.
  imports: [WorkflowModule, NotificationModule],
  controllers: [HrController, LeaveController, SalaryController, PayrollController, StaffLifecycleController, HrReviewsController],
  providers: [HrService, LeaveService, SalaryService, PayrollService, StaffLifecycleService, HrReviewsService],
  exports: [HrService, LeaveService, SalaryService, PayrollService, StaffLifecycleService, HrReviewsService],
})
export class HrModule {}
