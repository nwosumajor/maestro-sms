import { Module } from "@nestjs/common";
import { OperatorController } from "./operator.controller";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";
import { OperatorUserService } from "./operator-user.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";

@Module({
  controllers: [OperatorController],
  providers: [OperatorService, OperatorProvisioningService, OperatorUserService, PlatformAnalyticsService],
  exports: [OperatorService, OperatorProvisioningService, OperatorUserService],
})
export class OperatorModule {}
