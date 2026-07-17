import { Module } from "@nestjs/common";
import { GroupController } from "./group.controller";
import { GroupService } from "./group.service";

// Multi-school group console. Depends on the global FoundationModule
// (TENANT_DATABASE, AUDIT_LOG_SERVICE, guards) and the globally-provided
// PrivilegedDatabaseService. Exports GroupService for the operator console's
// group management endpoints.
@Module({
  controllers: [GroupController],
  providers: [GroupService],
  exports: [GroupService],
})
export class GroupModule {}
