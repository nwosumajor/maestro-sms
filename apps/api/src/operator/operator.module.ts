import { Module } from "@nestjs/common";
import { OperatorController } from "./operator.controller";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";

@Module({
  controllers: [OperatorController],
  providers: [OperatorService, OperatorProvisioningService],
  exports: [OperatorService, OperatorProvisioningService],
})
export class OperatorModule {}
