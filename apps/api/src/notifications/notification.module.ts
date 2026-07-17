import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PaymentsModule } from "../payments/payments.module";
import { MessageCreditsService } from "./message-credits.service";
import { NOTIFICATION_CHANNEL_PROVIDER, NOTIFICATION_QUEUE } from "./notification.constants";
import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { NotificationProcessor } from "./notification.processor";
import { LoggingChannelProvider } from "./logging-channel.provider";
import { TwilioChannelProvider } from "./twilio-channel.provider";
import { EmailService } from "./email.service";
import { EmailChannelProvider } from "./email-channel.provider";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Exports NotificationService so producer modules (e.g. Attendance)
// can enqueue notifications, and EmailService for DIRECT sends to non-users
// (e.g. the public onboarding requester, who has no account yet).
// Channel routing: EMAIL → EmailService (Resend/Postmark via EMAIL_API_KEY;
// log-stub without it); SMS → Twilio when SMS_PROVIDER=twilio; everything else →
// the logging stub. Each gateway degrades independently — a missing email key
// never affects SMS and vice versa.
@Module({
  // PaymentsModule: message-credit bundle purchases (Paystack) — one-way dep.
  imports: [BullModule.registerQueue({ name: NOTIFICATION_QUEUE }), PaymentsModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationProcessor,
    EmailService,
    MessageCreditsService,
    {
      provide: NOTIFICATION_CHANNEL_PROVIDER,
      inject: [EmailService],
      useFactory: (email: EmailService) => {
        const inner =
          process.env.SMS_PROVIDER === "twilio" ? new TwilioChannelProvider() : new LoggingChannelProvider();
        return new EmailChannelProvider(email, inner);
      },
    },
  ],
  exports: [NotificationService, EmailService, MessageCreditsService],
})
export class NotificationModule {}
