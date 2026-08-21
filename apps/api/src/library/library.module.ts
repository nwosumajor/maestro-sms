import { Module } from "@nestjs/common";
import { LibraryController } from "./library.controller";
import { LibraryService } from "./library.service";
import { NotificationModule } from "../notifications/notification.module";

// Library Management. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard).
// Imports NotificationModule so a fine announces itself — the borrower and, for
// a pupil, their guardians. LibraryModule is imported only by AppModule and the
// notification chain never reaches back here, so this edge adds no cycle (see
// test/payments/module-graph.spec.ts for why that is checked at all).
@Module({
  imports: [NotificationModule],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
