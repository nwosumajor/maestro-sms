import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import {
  AUDIT_LOG_SERVICE,
  TENANT_DATABASE,
} from "../integrity/integrity.foundation";
import { CONSENT_SERVICE } from "../integrity/integrity.constants";
import { PermissionGuard } from "../auth/permission.guard";
import { PrismaTenantService } from "./prisma-tenant.service";
import { AuditLogService } from "./audit-log.service";
import { ConsentService } from "./consent.service";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";

/**
 * The real foundation: tenant-scoped DB runner, durable audit log, NDPR consent,
 * credential verification (AuthController/AuthService), and the global auth
 * guard. @Global so the token providers reach IntegrityModule without re-import.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: TENANT_DATABASE, useClass: PrismaTenantService },
    { provide: AUDIT_LOG_SERVICE, useClass: AuditLogService },
    { provide: CONSENT_SERVICE, useClass: ConsentService },
    AuthService,
    // EMBEDDING_PROVIDER intentionally unbound — prose similarity is skipped
    // when absent (the integrity service injects it @Optional()).
  ],
  exports: [TENANT_DATABASE, AUDIT_LOG_SERVICE, CONSENT_SERVICE],
})
export class FoundationModule {}
