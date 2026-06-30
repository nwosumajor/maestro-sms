import { Module } from "@nestjs/common";
import { DiscussionController } from "./discussion.controller";
import { DiscussionService } from "./discussion.service";

// Discussion Hub. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard).
@Module({
  controllers: [DiscussionController],
  providers: [DiscussionService],
  exports: [DiscussionService],
})
export class DiscussionModule {}
