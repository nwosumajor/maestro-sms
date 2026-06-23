import { Module } from "@nestjs/common";
import { TimetableController } from "./timetable.controller";
import { TimetableService } from "./timetable.service";

// Depends on the global FoundationModule (TENANT_DATABASE, AUDIT_LOG_SERVICE,
// auth guard) — no re-import needed.
@Module({
  controllers: [TimetableController],
  providers: [TimetableService],
  exports: [TimetableService],
})
export class TimetableModule {}
