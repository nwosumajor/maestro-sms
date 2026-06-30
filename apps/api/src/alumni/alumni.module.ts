import { Module } from "@nestjs/common";
import { AlumniController } from "./alumni.controller";
import { AlumniService } from "./alumni.service";
import { NotificationModule } from "../notifications/notification.module";

// Alumni Management. Depends on the global FoundationModule + NotificationModule
// (alumni broadcasts).
@Module({
  imports: [NotificationModule],
  controllers: [AlumniController],
  providers: [AlumniService],
  exports: [AlumniService],
})
export class AlumniModule {}
