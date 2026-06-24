// =============================================================================
// IntegrityReportController — teacher/school_admin read endpoint
// =============================================================================
// Gated by integrity.report.read. Students and parents do NOT hold this
// permission, so they cannot reach raw signals here (spec "Surfacing"). Caller
// identity (incl. roles) comes from the foundation guard via @CurrentPrincipal.
// =============================================================================

import { Controller, Get, Param } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import type { IntegrityReportDto } from "@sms/types";
import { INTEGRITY_PERMISSIONS } from "@sms/types";
// --- foundation primitives (do not reimplement) ---
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "./integrity.foundation";
import { IntegrityReportService } from "./integrity-report.service";

@RequireModule(MODULES.INTEGRITY)
@Controller("assessments/:assessmentId/submissions/:submissionId")
export class IntegrityReportController {
  constructor(private readonly reports: IntegrityReportService) {}

  @Get("integrity-report")
  @RequirePermission(INTEGRITY_PERMISSIONS.REPORT_READ)
  async getReport(
    @CurrentPrincipal() principal: Principal,
    @Param("submissionId") submissionId: string,
  ): Promise<IntegrityReportDto> {
    return this.reports.getSubmissionReport(principal, submissionId);
  }
}
