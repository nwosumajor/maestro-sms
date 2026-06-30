import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { NOTIFICATION_CHANNEL_PROVIDER, NOTIFICATION_QUEUE } from "./notification.constants";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { NotificationProcessor } from "./notification.processor";
import { LoggingChannelProvider } from "./logging-channel.provider";
import { TwilioChannelProvider } from "./twilio-channel.provider";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Exports NotificationService so producer modules (e.g. Attendance)
// can enqueue notifications. The channel backend is the live Twilio-SMS provider
// when SMS_PROVIDER=twilio (SMS sends over Twilio; degrades to log-only without
// creds), else the logging stub.
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATION_QUEUE })],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationProcessor,
    {
      provide: NOTIFICATION_CHANNEL_PROVIDER,
      useClass: process.env.SMS_PROVIDER === "twilio" ? TwilioChannelProvider : LoggingChannelProvider,
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
