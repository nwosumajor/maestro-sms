import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { FeesController } from "./fees.controller";
import { FeesService } from "./fees.service";
import { PaymentGatewayService } from "./payment-gateway.service";
import { DisputesModule } from "./disputes.module";
import { SettlementModule } from "./settlement.module";
import { FEE_RECONCILE_QUEUE, PaymentReconciliationService } from "./reconciliation.service";
import { PaymentReconciliationScheduler } from "./reconciliation.scheduler";
import { PaymentReconciliationProcessor } from "./reconciliation.processor";
import { VirtualAccountsService } from "./virtual-accounts.service";
import { PaymentPlansService } from "./payment-plans.service";
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
  imports: [
    NotificationModule,
    PaymentsModule,
    BillingModule,
    AdmissionsModule,
    DisputesModule,
    SettlementModule,
    BullModule.registerQueue({ name: FEE_RECONCILE_QUEUE }),
  ],
  controllers: [FeesController],
  providers: [
    FeesService,
    PaymentGatewayService,
    VirtualAccountsService,
    PaymentPlansService,
    PaymentReconciliationService,
    PaymentReconciliationScheduler,
    PaymentReconciliationProcessor,
  ],
  exports: [FeesService],
})
export class FeesModule {}
