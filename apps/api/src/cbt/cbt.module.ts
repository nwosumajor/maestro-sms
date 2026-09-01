import { Module } from "@nestjs/common";
import { WorkflowModule } from "../workflow/workflow.module";
import { GradebookModule } from "../gradebook/gradebook.module";
import { NotificationModule } from "../notifications/notification.module";
import { CbtController } from "./cbt.controller";
import { CbtService } from "./cbt.service";
// A leaf module (controller + service + storage provider) — no cycle risk.
import { BrandingModule } from "../branding/branding.module";

// CBT exam hall — add-on module. Depends on the global FoundationModule
// (TENANT_DATABASE, AUDIT_LOG_SERVICE, guards) and the WorkflowModule for the
// exam-publish / answer-release maker-checker chains; all state is tenant-scoped.
@Module({
  imports: [BrandingModule, WorkflowModule, GradebookModule, NotificationModule],
  controllers: [CbtController],
  providers: [CbtService],
  // Exported so the ALWAYS-ON scholarship surface can serve a scholarship
  // sitting without the PREMIUM CBT module. One engine, two doors — a second
  // sampling or scoring path is how two exams start disagreeing about the same
  // answer.
  exports: [CbtService],
})
export class CbtModule {}
