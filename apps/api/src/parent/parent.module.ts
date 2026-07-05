import { Module } from "@nestjs/common";
import { ParentController } from "./parent.controller";
import { ParentService } from "./parent.service";
import { ParentImportController } from "./parent-import.controller";
import { ParentImportService } from "./parent-import.service";

// Parent portal + parent onboarding. The portal is a read-only aggregation over
// existing modules' tables (always ParentChild-scoped); onboarding creates
// parent accounts (single + bulk maker-checker) with generated logins and
// ParentChild links. Depends only on the global FoundationModule providers.
@Module({
  controllers: [ParentController, ParentImportController],
  providers: [ParentService, ParentImportService],
})
export class ParentModule {}
