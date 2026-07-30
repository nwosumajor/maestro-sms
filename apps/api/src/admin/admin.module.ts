import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { StudentImportService } from "./student-import.service";
import { WorkflowModule } from "../workflow/workflow.module";
import { SisModule } from "../sis/sis.module";

@Module({
  imports: [WorkflowModule, SisModule],
  controllers: [AdminController],
  providers: [AdminService, StudentImportService],
  exports: [AdminService, StudentImportService],
})
export class AdminModule {}
