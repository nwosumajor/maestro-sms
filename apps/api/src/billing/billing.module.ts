import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { NotificationModule } from "../notifications/notification.module";
import { PaymentsModule } from "../payments/payments.module";
import { BILLING_DATABASE, BILLING_DUNNING_QUEUE } from "./billing.constants";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { PrivilegedDatabaseService } from "../common/privileged-database.service";
import { BillingDunningService } from "./billing-dunning.service";
import { BillingDunningScheduler } from "./billing-dunning.scheduler";
import { BillingDunningProcessor } from "./billing-dunning.processor";
import { PlanPricingService } from "./plan-pricing.service";
import { ReferralService } from "./referral.service";
import { PlatformFeeService } from "./platform-fee.service";
import { GrowthService } from "./growth.service";

// School self-serve platform billing. Depends on the global FoundationModule
// (TENANT_DATABASE, AUDIT_LOG_SERVICE, ModuleEntitlementService), the shared
// PaystackService, and NotificationModule (payment confirmation + dunning
// reminders). Exports BillingService so the Fees webhook can dispatch verified
// `metadata.kind === "subscription"` events to it (one-way dep fees -> billing).
@Module({
  imports: [
    NotificationModule,
    PaymentsModule,
    BullModule.registerQueue({ name: BILLING_DUNNING_QUEUE }),
  ],
  controllers: [BillingController],
  providers: [
    BillingService,
    BillingDunningService,
    BillingDunningScheduler,
    BillingDunningProcessor,
    PlanPricingService,
    ReferralService,
    PlatformFeeService,
    GrowthService,
    { provide: BILLING_DATABASE, useExisting: PrivilegedDatabaseService },
  ],
  // PlanPricingService is exported for the operator console (super_admin sets
  // tier prices, step-up gated) and the public pricing endpoint (landing page).
  // PlatformFeeService feeds the fees payment gateway (take-rate) + operator PUT.
  // GrowthService feeds operator promo/agent management + provisioning attribution.
  exports: [BillingService, PlanPricingService, PlatformFeeService, GrowthService],
})
export class BillingModule {}
