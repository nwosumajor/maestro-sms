import { Module } from "@nestjs/common";
import { PaystackService } from "./paystack.service";
import { StripeService } from "./stripe.service";
import { GatewayEventService } from "./gateway-event.service";
import { AirtelProvider, MpesaProvider, MtnMomoProvider } from "./mobile-money.provider";

// Shared payment-gateway clients. Paystack (NGN) is imported by both FeesModule
// (parent->school invoices) and BillingModule (school->platform subscriptions);
// Stripe (USD) serves platform subscriptions only — ONE place per gateway that
// talks to the API and verifies its webhook signature.
// STAYS A LEAF. NotificationModule imports this one (message credits), so anything
// here that imported SettlementModule — which imports NotificationModule — would
// close a cycle and the app would not boot. The mobile-money RAIL therefore lives in
// its own module; only the stateless provider ADAPTERS live here, beside the other
// gateway clients.
@Module({
  providers: [PaystackService, StripeService, GatewayEventService, MpesaProvider, MtnMomoProvider, AirtelProvider],
  exports: [PaystackService, StripeService, GatewayEventService, MpesaProvider, MtnMomoProvider, AirtelProvider],
})
export class PaymentsModule {}
