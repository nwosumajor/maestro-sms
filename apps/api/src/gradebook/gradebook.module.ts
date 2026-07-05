import { Module } from "@nestjs/common";
import { WorkflowModule } from "../workflow/workflow.module";
import { GradebookController } from "./gradebook.controller";
import { GradebookService } from "./gradebook.service";
import { TermResultService } from "./term-result.service";
import { SubjectSelectionService } from "./subject-selection.service";

// WorkflowModule: grade publishing is maker-checker — TermResultService raises a
// GRADE_PUBLISH request (head teacher → principal) and reacts to its approval
// via WorkflowHooksService (one-way dep, same pattern as hostel/transport fees).
@Module({
  imports: [WorkflowModule],
  controllers: [GradebookController],
  providers: [GradebookService, TermResultService, SubjectSelectionService],
  exports: [GradebookService, TermResultService, SubjectSelectionService],
})
export class GradebookModule {}
