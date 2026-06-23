import { Module } from "@nestjs/common";
import { MessagingController } from "./messaging.controller";
import { MessagingService } from "./messaging.service";
import { EventsController } from "./events.controller";
import { EventsService } from "./events.service";
import { NotificationModule } from "../notifications/notification.module";

// Messaging (notifies the other participant via Notifications) + Calendar events.
// Depends on the global FoundationModule.
@Module({
  imports: [NotificationModule],
  controllers: [MessagingController, EventsController],
  providers: [MessagingService, EventsService],
  exports: [MessagingService, EventsService],
})
export class CommunicationModule {}
