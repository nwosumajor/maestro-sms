import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { NOTIFICATION_CHANNEL_PROVIDER, NOTIFICATION_QUEUE } from "./notification.constants";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { NotificationProcessor } from "./notification.processor";
import { LoggingChannelProvider } from "./logging-channel.provider";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Exports NotificationService so producer modules (e.g. Attendance)
// can enqueue notifications.
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATION_QUEUE })],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationProcessor,
    // Default channel backend: a logging stub. Production swaps in SES/Twilio/FCM.
    { provide: NOTIFICATION_CHANNEL_PROVIDER, useClass: LoggingChannelProvider },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
