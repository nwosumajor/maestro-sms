import { Module } from "@nestjs/common";
import { FeesController } from "./fees.controller";
import { FeesService } from "./fees.service";
import { PaymentGatewayService } from "./payment-gateway.service";
import { DisputesModule } from "./disputes.module";
import { NotificationModule } from "../notifications/notification.module";
import { PaymentsModule } from "../payments/payments.module";
import { BillingModule } from "../billing/billing.module";
import { AdmissionsModule } from "../admissions/admissions.module";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Imports NotificationModule to alert guardians on invoice issue
// and full payment, the shared PaymentsModule (Paystack client), and BillingModule
// so the single account-wide webhook can dispatch subscription events to it
// (one-way dep fees -> billing; billing never imports fees).
@Module({
  // AdmissionsModule: the single account-wide webhook also dispatches
  // metadata.kind === "admission_form" charges to it (one-way fees -> admissions).
  imports: [NotificationModule, PaymentsModule, BillingModule, AdmissionsModule, DisputesModule],
  controllers: [FeesController],
  providers: [FeesService, PaymentGatewayService],
  exports: [FeesService],
})
export class FeesModule {}
