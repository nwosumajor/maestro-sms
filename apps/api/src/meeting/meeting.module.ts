import { Module } from "@nestjs/common";
import { MeetingController } from "./meeting.controller";
import { MeetingService } from "./meeting.service";
import { MeetingRequestService } from "./meeting-request.service";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [NotificationModule],
  controllers: [MeetingController],
  providers: [MeetingService, MeetingRequestService],
})
export class MeetingModule {}
