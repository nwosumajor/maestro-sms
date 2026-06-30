import { Module } from "@nestjs/common";
import { HostelController } from "./hostel.controller";
import { HostelService } from "./hostel.service";

// Hostel Management. Depends on the global FoundationModule (TENANT_DATABASE,
// AUDIT_LOG_SERVICE, auth guard). Hostel fees are written into the shared Fees
// tables (Invoice/InvoiceLineItem) directly via the tenant tx — one DB, one RLS.
@Module({
  controllers: [HostelController],
  providers: [HostelService],
  exports: [HostelService],
})
export class HostelModule {}
