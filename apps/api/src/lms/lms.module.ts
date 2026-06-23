import { Module } from "@nestjs/common";
import { LmsController } from "./lms.controller";
import { LmsService } from "./lms.service";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed.
@Module({
  controllers: [LmsController],
  providers: [LmsService],
  exports: [LmsService],
})
export class LmsModule {}
