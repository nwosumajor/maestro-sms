import { Module } from "@nestjs/common";
import { ReportCardController } from "./reportcard.controller";
import { ReportCardService } from "./reportcard.service";
import { NotificationModule } from "../notifications/notification.module";
import { BrandingModule } from "../branding/branding.module";

@Module({
  imports: [NotificationModule, BrandingModule],
  controllers: [ReportCardController],
  providers: [ReportCardService],
  exports: [ReportCardService],
})
export class ReportCardModule {}
