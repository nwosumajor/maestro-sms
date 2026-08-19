import { Module } from "@nestjs/common";
import { DiscussionController } from "./discussion.controller";
import { DiscussionService } from "./discussion.service";
import { DisciplineModule } from "../discipline/discipline.module";

// Discussion Hub. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard).
//
// DisciplineModule: reporting a post files a discipline complaint rather than
// building a second review pipeline beside the one that already exists. ONE-WAY
// — Discipline imports only NotificationModule and knows nothing about
// Discussion — so this cannot become a cycle. A cycle here would not fail a
// unit test; it would stop Nest booting, which is why test/payments/
// module-graph.spec.ts exists.
@Module({
  imports: [DisciplineModule],
  controllers: [DiscussionController],
  providers: [DiscussionService],
  exports: [DiscussionService],
})
export class DiscussionModule {}
