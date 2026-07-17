import { Module } from "@nestjs/common";
import { AdmissionsController } from "./admissions.controller";
import { AdmissionsService } from "./admissions.service";
import { NOTIFICATION_CHANNEL_PROVIDER } from "../notifications/notification.constants";
import { LoggingChannelProvider } from "../notifications/logging-channel.provider";
import { PaymentsModule } from "../payments/payments.module";
import { BillingModule } from "../billing/billing.module";

@Module({
  // PaymentsModule: form-fee checkout (Paystack); BillingModule: the platform
  // take-rate on the fee. One-way deps — neither imports admissions.
  imports: [PaymentsModule, BillingModule],
  controllers: [AdmissionsController],
  providers: [
    AdmissionsService,
    // Applicants are NOT users, so the maker-checker decision is emailed directly
    // to applicantEmail via the same pluggable channel backend (stub logs; prod
    // binds SES). Provided here so AdmissionsService can inject it.
    { provide: NOTIFICATION_CHANNEL_PROVIDER, useClass: LoggingChannelProvider },
  ],
  exports: [AdmissionsService],
})
export class AdmissionsModule {}
