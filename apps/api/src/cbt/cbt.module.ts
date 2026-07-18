import { Module } from "@nestjs/common";
import { WorkflowModule } from "../workflow/workflow.module";
import { CbtController } from "./cbt.controller";
import { CbtService } from "./cbt.service";

// CBT exam hall — add-on module. Depends on the global FoundationModule
// (TENANT_DATABASE, AUDIT_LOG_SERVICE, guards) and the WorkflowModule for the
// exam-publish / answer-release maker-checker chains; all state is tenant-scoped.
@Module({
  imports: [WorkflowModule],
  controllers: [CbtController],
  providers: [CbtService],
})
export class CbtModule {}
