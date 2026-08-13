import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AlumniController } from "./alumni.controller";
import { ALUMNI_BROADCAST_QUEUE } from "./alumni.constants";
import { AlumniBroadcastProcessor } from "./alumni.processor";
import { AlumniService } from "./alumni.service";
import { NotificationModule } from "../notifications/notification.module";

// Alumni Management. Depends on the global FoundationModule + NotificationModule
// (alumni broadcasts).
@Module({
  imports: [NotificationModule, BullModule.registerQueue({ name: ALUMNI_BROADCAST_QUEUE })],
  controllers: [AlumniController],
  providers: [AlumniService, AlumniBroadcastProcessor],
  exports: [AlumniService],
})
export class AlumniModule {}
