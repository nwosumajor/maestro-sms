import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { StudentImportService } from "./student-import.service";
import { WorkflowModule } from "../workflow/workflow.module";

@Module({
  imports: [WorkflowModule],
  controllers: [AdminController],
  providers: [AdminService, StudentImportService],
  exports: [AdminService, StudentImportService],
})
export class AdminModule {}
