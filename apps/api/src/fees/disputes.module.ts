import { Module } from "@nestjs/common";
import { DisputesController } from "./disputes.controller";
import { DisputesService } from "./disputes.service";
import { NotificationModule } from "../notifications/notification.module";
import { PaymentsModule } from "../payments/payments.module";

// Dispute ingestion is its OWN module because BOTH gateway webhooks feed it:
// FeesModule (Paystack account webhook) and BillingModule (Stripe webhook)
// import it — it imports neither, so no cycle. PaymentsModule provides the
// StripeService used to fetch a disputed charge's metadata; the privileged
// client (operator alerts) comes from the @Global PrivilegedDatabaseModule.
@Module({
  imports: [NotificationModule, PaymentsModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
