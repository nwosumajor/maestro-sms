import { Module } from "@nestjs/common";
import { ApprovalsController } from "./approvals.controller";
import { PendingApprovalsService } from "./pending-approvals.service";

// Read-only aggregator over other modules' pending-approval tables. It imports
// NOTHING from those modules (no service dependencies, no cycles) — it reads
// their tables through the shared tenant client, so each module keeps sole
// ownership of its decision logic.
@Module({
  controllers: [ApprovalsController],
  providers: [PendingApprovalsService],
})
export class ApprovalsModule {}
