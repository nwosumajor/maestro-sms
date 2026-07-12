// =============================================================================
// ExitController — exit management (initiate hr.write; decide = step-up money)
// =============================================================================

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { HR_PERMISSIONS, MODULES } from "@sms/types";
import type { StaffExitDto } from "@sms/types";
import { RequireModule } from "../auth/require-module.decorator";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { ExitService } from "./exit.service";

const initiateSchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(["RESIGNATION", "TERMINATION", "RETIREMENT"]),
  lastWorkingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(500).optional(),
});
const decideSchema = z.object({ approve: z.boolean() });

@RequireModule(MODULES.HR)
@Controller("hr/exits")
export class ExitController {
  constructor(private readonly exits: ExitService) {}

  @Post()
  @RequirePermission(HR_PERMISSIONS.HR_WRITE)
  initiate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(initiateSchema)) b: z.infer<typeof initiateSchema>,
  ): Promise<StaffExitDto> {
    return this.exits.initiate(p, b);
  }

  /** Settlement moves money → step-up, and the initiator can never decide. */
  @Post(":id/decide")
  @RequirePermission(HR_PERMISSIONS.HR_SALARY_APPROVE)
  @RequireStepUp()
  decide(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(decideSchema)) b: z.infer<typeof decideSchema>,
  ): Promise<StaffExitDto> {
    return this.exits.decide(p, id, b.approve);
  }

  @Get()
  @RequirePermission(HR_PERMISSIONS.HR_READ)
  list(@CurrentPrincipal() p: Principal): Promise<StaffExitDto[]> {
    return this.exits.list(p);
  }
}
