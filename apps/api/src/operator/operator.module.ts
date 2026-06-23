import { Module } from "@nestjs/common";
import { OperatorController } from "./operator.controller";
import { OperatorService } from "./operator.service";

@Module({
  controllers: [OperatorController],
  providers: [OperatorService],
  exports: [OperatorService],
})
export class OperatorModule {}
