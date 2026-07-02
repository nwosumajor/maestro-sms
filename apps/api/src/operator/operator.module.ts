import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { OperatorController } from "./operator.controller";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";
import { OperatorUserService } from "./operator-user.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";
import { PlatformAuditService } from "./platform-audit.service";

// BillingModule provides PlanPricingService — the operator console reads/sets
// the platform's per-tier pricing (one-way dep operator -> billing, no cycle).
@Module({
  imports: [BillingModule],
  controllers: [OperatorController],
  providers: [OperatorService, OperatorProvisioningService, OperatorUserService, PlatformAnalyticsService, PlatformAuditService],
  exports: [OperatorService, OperatorProvisioningService, OperatorUserService],
})
export class OperatorModule {}
