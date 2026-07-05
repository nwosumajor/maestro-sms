import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { PrivacyModule } from "../privacy/privacy.module";
import { OperatorController } from "./operator.controller";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";
import { OperatorUserService } from "./operator-user.service";
import { OperatorExportService } from "./operator-export.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";
import { PlatformAuditService } from "./platform-audit.service";

// BillingModule provides PlanPricingService — the operator console reads/sets
// the platform's per-tier pricing (one-way dep operator -> billing, no cycle).
// PrivacyModule provides PrivacyService — reused by the cross-tenant student
// data export (one-way dep operator -> privacy).
@Module({
  imports: [BillingModule, PrivacyModule],
  controllers: [OperatorController],
  providers: [OperatorService, OperatorProvisioningService, OperatorUserService, OperatorExportService, PlatformAnalyticsService, PlatformAuditService],
  exports: [OperatorService, OperatorProvisioningService, OperatorUserService],
})
export class OperatorModule {}
