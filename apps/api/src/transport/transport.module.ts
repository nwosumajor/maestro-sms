import { Module } from "@nestjs/common";
import { TransportController } from "./transport.controller";
import { TransportService } from "./transport.service";
import { NotificationModule } from "../notifications/notification.module";

// Transport Management. Depends on the global FoundationModule + NotificationModule
// (route-change parent alerts). Transport fees are written into the shared Fees
// tables via the tenant tx — one DB, one RLS.
@Module({
  imports: [NotificationModule],
  controllers: [TransportController],
  providers: [TransportService],
  exports: [TransportService],
})
export class TransportModule {}
