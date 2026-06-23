import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";

// Read-only aggregates over existing module data (RLS-scoped). Depends on the
// global FoundationModule (TENANT_DATABASE, auth guard).
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
