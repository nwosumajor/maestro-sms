import { Module } from "@nestjs/common";
import { ExamController } from "./exam.controller";
import { ExamService } from "./exam.service";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [NotificationModule],
  controllers: [ExamController],
  providers: [ExamService],
})
export class ExamModule {}
