// =============================================================================
// EmploymentController — confirmation/promotion/renewal maker-checker endpoints
// =============================================================================

import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { HR_PERMISSIONS, MODULES } from "@sms/types";
import type { EmploymentChangeDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { EmploymentService } from "./employment.service";

const requestSchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(["CONFIRMATION", "PROMOTION", "RENEWAL"]),
  newJobTitle: z.string().max(120).optional(),
  newGradeLevel: z.string().max(40).optional(),
  newEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().max(500).optional(),
});
const decideSchema = z.object({ approve: z.boolean() });

@RequireModule(MODULES.HR)
@Controller("hr/employment")
export class EmploymentController {
  constructor(private readonly employment: EmploymentService) {}

  /** Maker (hr.write). */
  @Post("changes")
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  request(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(requestSchema)) b: z.infer<typeof requestSchema>,
  ): Promise<EmploymentChangeDto> {
    return this.employment.request(p, b);
  }

  /** Checker (hr.salary.approve; ≠ requester — enforced in the service). */
  @Post("changes/:id/decide")
  @RequirePermission(HR_PERMISSIONS.HR_SALARY_APPROVE)
  decide(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(decideSchema)) b: z.infer<typeof decideSchema>,
  ): Promise<EmploymentChangeDto> {
    return this.employment.decide(p, id, b.approve);
  }

  @Get("changes")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  list(@CurrentPrincipal() p: Principal, @Query("userId") userId?: string): Promise<EmploymentChangeDto[]> {
    return this.employment.list(p, userId);
  }
}
