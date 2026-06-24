import { Controller, Get, Param } from "@nestjs/common";
import { MODULES } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { INTEGRITY_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentTenant } from "../auth/current-tenant.decorator";
import type { TenantContext } from "./integrity.foundation";
import { IntegrityService } from "./integrity.service";

/**
 * Student-facing endpoint that loads the assessment-taking context (their
 * submission + resolved integrity config). Gated by assessment.read; ownership
 * of the submission is guaranteed because it's keyed to the caller.
 */
@RequireModule(MODULES.INTEGRITY)
@Controller("assessments/:assessmentId")
export class AssessmentTakeController {
  constructor(private readonly integrity: IntegrityService) {}

  @Get("take")
  @RequirePermission(INTEGRITY_PERMISSIONS.ASSESSMENT_READ)
  take(
    @CurrentTenant() ctx: TenantContext,
    @Param("assessmentId") assessmentId: string,
  ) {
    return this.integrity.getTakeContext(ctx, assessmentId);
  }
}
