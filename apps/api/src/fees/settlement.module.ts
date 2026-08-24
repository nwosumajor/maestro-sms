import { Module } from "@nestjs/common";
import { InvoiceSettlementService } from "./settlement.service";
import { NotificationModule } from "../notifications/notification.module";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";

// The one shared "post an online invoice payment" implementation. Its OWN
// module because four paths feed it: the Paystack account webhook + the
// payer's verify-on-return confirm + the reconciliation sweep (FeesModule)
// and the Stripe webhook's kind=invoice dispatch (BillingModule). It imports
// neither, so no cycle.
@Module({
  imports: [NotificationModule],
  // The privileged client is for ONE thing here: telling the platform owner
  // that money arrived for a school that is switched off. It is cross-tenant by
  // nature (the recipients are super_admins in the platform org) and the
  // service takes it @Optional, so an environment without the privileged URL
  // still settles normally and simply cannot send that alert.
  providers: [InvoiceSettlementService, PrivilegedDatabaseService],
  exports: [InvoiceSettlementService],
})
export class SettlementModule {}
