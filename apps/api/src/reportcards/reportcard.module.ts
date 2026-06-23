import { Module } from "@nestjs/common";
import { ReportCardController } from "./reportcard.controller";
import { ReportCardService } from "./reportcard.service";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [NotificationModule],
  controllers: [ReportCardController],
  providers: [ReportCardService],
  exports: [ReportCardService],
})
export class ReportCardModule {}
