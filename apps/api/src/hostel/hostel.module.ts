import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { WorkflowModule } from "../workflow/workflow.module";
import { NotificationModule } from "../notifications/notification.module";
import { HostelController } from "./hostel.controller";
import { HostelService } from "./hostel.service";
import { ExeatOverdueService } from "./exeat-overdue.service";
import { ExeatOverdueScheduler } from "./exeat-overdue.scheduler";
import { ExeatOverdueProcessor } from "./exeat-overdue.processor";
import { EXEAT_OVERDUE_QUEUE } from "./hostel.constants";

// Hostel Management. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard). Hostel fees are written into the shared Fees
// tables (Invoice/InvoiceLineItem) directly via the tenant tx — one DB, one RLS.
@Module({
  imports: [WorkflowModule, NotificationModule, BullModule.registerQueue({ name: EXEAT_OVERDUE_QUEUE })],
  controllers: [HostelController],
  providers: [HostelService, ExeatOverdueService, ExeatOverdueScheduler, ExeatOverdueProcessor],
  exports: [HostelService, ExeatOverdueService],
})
export class HostelModule {}
