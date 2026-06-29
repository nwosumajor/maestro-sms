import { Controller, Get, Param } from "@nestjs/common";
import { MODULES, INTEGRITY_PERMISSIONS } from "@sms/types";
import type { AssessmentSubmissionDto, AssessmentSummaryDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { Principal } from "./integrity.foundation";
import { AssessmentListService } from "./assessment-list.service";

/** Index + drill-down for the Assessments section. Relationship-scoped in the
 *  service; module-gated + permission-gated here. */
@RequireModule(MODULES.INTEGRITY)
@Controller("assessments")
export class AssessmentListController {
  constructor(private readonly assessments: AssessmentListService) {}

  @Get()
  @RequirePermission(INTEGRITY_PERMISSIONS.ASSESSMENT_READ)
  list(@CurrentPrincipal() p: Principal): Promise<AssessmentSummaryDto[]> {
    return this.assessments.listAssessments(p);
  }

  @Get(":assessmentId/submissions")
  @RequirePermission(INTEGRITY_PERMISSIONS.REPORT_READ)
  submissions(
    @CurrentPrincipal() p: Principal,
    @Param("assessmentId") assessmentId: string,
  ): Promise<AssessmentSubmissionDto[]> {
    return this.assessments.listSubmissions(p, assessmentId);
  }
}
