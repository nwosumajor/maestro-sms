import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { MODULES, HR_PERMISSIONS } from "@sms/types";
import type { SalaryChangeDto } from "@sms/types";
import { z } from "zod";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { SalaryService } from "./salary.service";

const requestSchema = z.object({
  newSalaryMinor: z.number().int().min(0),
  reason: z.string().max(500).nullish(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
const decideSchema = z.object({ approve: z.boolean(), reason: z.string().max(500).nullish() });

@RequireModule(MODULES.HR)
@Controller("hr/salary")
export class SalaryController {
  constructor(private readonly salary: SalaryService) {}

  /** Maker: request a salary change (sensitive — step-up re-auth required). */
  @Post("employees/:employeeId/changes")
  @RequirePermission(HR_PERMISSIONS.HR_SALARY_REQUEST)
  @RequireStepUp()
  request(
    @CurrentPrincipal() p: Principal,
    @Param("employeeId") employeeId: string,
    @Body(new ZodValidationPipe(requestSchema)) body: z.infer<typeof requestSchema>,
  ): Promise<SalaryChangeDto> {
    return this.salary.requestChange(p, employeeId, body);
  }

  /** Checker: approve/reject (must differ from requester; step-up required). */
  @Post("changes/:id/decide")
  @RequirePermission(HR_PERMISSIONS.HR_SALARY_APPROVE)
  @RequireStepUp()
  decide(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(decideSchema)) body: z.infer<typeof decideSchema>,
  ): Promise<SalaryChangeDto> {
    return this.salary.decide(p, id, body.approve, body.reason);
  }

  @Get("changes")
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  list(
    @CurrentPrincipal() p: Principal,
    @Query("employeeId") employeeId?: string,
  ): Promise<SalaryChangeDto[]> {
    return this.salary.list(p, employeeId);
  }
}
