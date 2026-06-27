import { Module } from "@nestjs/common";
import { PaystackService } from "./paystack.service";

// Shared Paystack client. Imported by both FeesModule (parent->school invoices)
// and BillingModule (school->platform subscriptions) so there is ONE place that
// talks to Paystack and verifies its webhook signature.
@Module({
  providers: [PaystackService],
  exports: [PaystackService],
})
export class PaymentsModule {}
