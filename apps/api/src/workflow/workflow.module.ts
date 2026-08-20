import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";
import { WorkflowHooksService } from "./workflow-hooks.service";
import { NotificationModule } from "../notifications/notification.module";

// NotificationModule: the engine tells whoever must act next. SAFE — Notification
// imports only BullModule and PaymentsModule, and neither reaches Workflow, so
// this cannot close a cycle. A cycle here would stop Nest booting rather than
// fail a test, which is why the boot is checked as well as the suite.
@Module({
  imports: [NotificationModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowHooksService],
  // WorkflowHooksService is exported so reactor modules (e.g. HR leave) can
  // register a finalized-handler without the engine depending on them.
  exports: [WorkflowService, WorkflowHooksService],
})
export class WorkflowModule {}
