import { Module } from "@nestjs/common";
import { OperatorController } from "./operator.controller";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";
import { OperatorUserService } from "./operator-user.service";

@Module({
  controllers: [OperatorController],
  providers: [OperatorService, OperatorProvisioningService, OperatorUserService],
  exports: [OperatorService, OperatorProvisioningService, OperatorUserService],
})
export class OperatorModule {}
