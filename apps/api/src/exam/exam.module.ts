import { Module } from "@nestjs/common";
import { ExamController } from "./exam.controller";
import { ExamService } from "./exam.service";
import { NotificationModule } from "../notifications/notification.module";
import { WorkflowModule } from "../workflow/workflow.module";

@Module({
  imports: [NotificationModule, WorkflowModule],
  controllers: [ExamController],
  providers: [ExamService],
})
export class ExamModule {}
