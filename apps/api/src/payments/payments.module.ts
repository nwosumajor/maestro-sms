import { Module } from "@nestjs/common";
import { PaystackService } from "./paystack.service";
import { StripeService } from "./stripe.service";

// Shared payment-gateway clients. Paystack (NGN) is imported by both FeesModule
// (parent->school invoices) and BillingModule (school->platform subscriptions);
// Stripe (USD) serves platform subscriptions only — ONE place per gateway that
// talks to the API and verifies its webhook signature.
@Module({
  providers: [PaystackService, StripeService],
  exports: [PaystackService, StripeService],
})
export class PaymentsModule {}
