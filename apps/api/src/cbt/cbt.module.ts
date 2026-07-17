import { Module } from "@nestjs/common";
import { CbtController } from "./cbt.controller";
import { CbtService } from "./cbt.service";

// CBT exam hall — add-on module. Depends only on the global FoundationModule
// (TENANT_DATABASE, AUDIT_LOG_SERVICE, guards); all state is tenant-scoped.
@Module({
  controllers: [CbtController],
  providers: [CbtService],
})
export class CbtModule {}
