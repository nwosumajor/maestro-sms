import { Module } from "@nestjs/common";
import { FeesController } from "./fees.controller";
import { FeesService } from "./fees.service";
import { PaymentGatewayService } from "./payment-gateway.service";
import { NotificationModule } from "../notifications/notification.module";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard). Imports NotificationModule to alert guardians on invoice issue
// and full payment.
@Module({
  imports: [NotificationModule],
  controllers: [FeesController],
  providers: [FeesService, PaymentGatewayService],
  exports: [FeesService],
})
export class FeesModule {}
