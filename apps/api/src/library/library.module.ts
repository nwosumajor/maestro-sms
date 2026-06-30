import { Module } from "@nestjs/common";
import { LibraryController } from "./library.controller";
import { LibraryService } from "./library.service";

// Library Management. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard).
@Module({
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
