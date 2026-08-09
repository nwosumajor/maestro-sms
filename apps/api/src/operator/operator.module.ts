import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { NotificationModule } from "../notifications/notification.module";
import { PrivacyModule } from "../privacy/privacy.module";
import { GroupModule } from "../group/group.module";
import { OperatorController } from "./operator.controller";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";
import { OperatorUserService } from "./operator-user.service";
import { OperatorExportService } from "./operator-export.service";
import { OperatorAttentionService } from "./operator-attention.service";
import { PlatformDelegationService } from "./platform-delegation.service";
import { OperatorDirectoryService } from "./operator-directory.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";
import { PlatformAuditService } from "./platform-audit.service";
import { OperatorCreditsService } from "./operator-credits.service";
import { PaymentsModule } from "../payments/payments.module";

// BillingModule provides PlanPricingService — the operator console reads/sets
// the platform's per-tier pricing (one-way dep operator -> billing, no cycle).
// PrivacyModule provides PrivacyService — reused by the cross-tenant student
// data export (one-way dep operator -> privacy).
// NotificationModule: provisioning welcomes the founding admins in-app.
@Module({
  // PaymentsModule for the payment-channel switchboard the operator owns. It is
  // a leaf module (no imports of its own), so this cannot introduce a cycle.
  imports: [BillingModule, NotificationModule, PrivacyModule, GroupModule, PaymentsModule],
  controllers: [OperatorController],
  providers: [OperatorService, OperatorProvisioningService, OperatorUserService, OperatorExportService, OperatorDirectoryService,
    OperatorAttentionService, PlatformDelegationService, PlatformAnalyticsService, PlatformAuditService, OperatorCreditsService],
  exports: [OperatorService, OperatorProvisioningService, OperatorUserService],
})
export class OperatorModule {}
