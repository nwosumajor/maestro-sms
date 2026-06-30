import { Module } from "@nestjs/common";
import { PollController } from "./poll.controller";
import { PollService } from "./poll.service";

// Polling System. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard). Anonymity is enforced in the service.
@Module({
  controllers: [PollController],
  providers: [PollService],
  exports: [PollService],
})
export class PollModule {}
