import { Module } from "@nestjs/common";
import { PaystackService } from "./paystack.service";
import { StripeService } from "./stripe.service";
import { GatewayEventService } from "./gateway-event.service";

// Shared payment-gateway clients. Paystack (NGN) is imported by both FeesModule
// (parent->school invoices) and BillingModule (school->platform subscriptions);
// Stripe (USD) serves platform subscriptions only — ONE place per gateway that
// talks to the API and verifies its webhook signature.
@Module({
  providers: [PaystackService, StripeService, GatewayEventService],
  exports: [PaystackService, StripeService, GatewayEventService],
})
export class PaymentsModule {}
