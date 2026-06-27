import { Module } from "@nestjs/common";
import { WorkflowController } from "./workflow.controller";
import { WorkflowService } from "./workflow.service";
import { WorkflowHooksService } from "./workflow-hooks.service";

@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowHooksService],
  // WorkflowHooksService is exported so reactor modules (e.g. HR leave) can
  // register a finalized-handler without the engine depending on them.
  exports: [WorkflowService, WorkflowHooksService],
})
export class WorkflowModule {}
