import { Module } from "@nestjs/common";
import { InvoiceSettlementService } from "./settlement.service";
import { NotificationModule } from "../notifications/notification.module";

// The one shared "post an online invoice payment" implementation. Its OWN
// module because four paths feed it: the Paystack account webhook + the
// payer's verify-on-return confirm + the reconciliation sweep (FeesModule)
// and the Stripe webhook's kind=invoice dispatch (BillingModule). It imports
// neither, so no cycle.
@Module({
  imports: [NotificationModule],
  providers: [InvoiceSettlementService],
  exports: [InvoiceSettlementService],
})
export class SettlementModule {}
