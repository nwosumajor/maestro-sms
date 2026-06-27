import { Module } from "@nestjs/common";
import { FeesController } from "./fees.controller";
import { FeesService } from "./fees.service";
import { PaymentGatewayService } from "./payment-gateway.service";
import { NotificationModule } from "../notifications/notification.module";
import { PaymentsModule } from "../payments/payments.module";
import { BillingModule } from "../billing/billing.module";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Imports NotificationModule to alert guardians on invoice issue
// and full payment, the shared PaymentsModule (Paystack client), and BillingModule
// so the single account-wide webhook can dispatch subscription events to it
// (one-way dep fees -> billing; billing never imports fees).
@Module({
  imports: [NotificationModule, PaymentsModule, BillingModule],
  controllers: [FeesController],
  providers: [FeesService, PaymentGatewayService],
  exports: [FeesService],
})
export class FeesModule {}
