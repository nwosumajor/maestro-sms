import { Module } from "@nestjs/common";
import { PrivacyController } from "./privacy.controller";
import { PrivacyService } from "./privacy.service";

// NDPR data-subject rights (export + erasure requests). Depends on the global
// FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE, auth guard).
@Module({
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
