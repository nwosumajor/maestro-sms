import { Module } from "@nestjs/common";
import { SisController } from "./sis.controller";
import { SisService } from "./sis.service";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed.
@Module({
  controllers: [SisController],
  providers: [SisService],
  exports: [SisService],
})
export class SisModule {}
