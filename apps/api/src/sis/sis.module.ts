import { Module } from "@nestjs/common";
import { NotificationModule } from "../notifications/notification.module";
import { SisController } from "./sis.controller";
import { SisService } from "./sis.service";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed.
@Module({
  imports: [NotificationModule],
  controllers: [SisController],
  providers: [SisService],
  exports: [SisService],
})
export class SisModule {}
