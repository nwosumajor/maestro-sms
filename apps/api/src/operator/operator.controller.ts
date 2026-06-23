import { Body, Controller, Get, Post } from "@nestjs/common";
import type { TenantDto } from "@sms/types";
import { z } from "zod";
import { OPERATOR_PERMISSIONS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { OperatorService } from "./operator.service";

const impSchema = z.object({ schoolId: z.string().uuid(), userId: z.string().uuid() });

@Controller("operator")
export class OperatorController {
  constructor(private readonly operator: OperatorService) {}

  @Get("tenants")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  tenants(@CurrentPrincipal() p: Principal): Promise<TenantDto[]> {
    return this.operator.listTenants(p);
  }

  /** Impersonation requires a fresh step-up — the riskiest action in the system. */
  @Post("impersonate")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  @RequireStepUp()
  impersonate(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(impSchema)) body: { schoolId: string; userId: string },
  ) {
    return this.operator.impersonate(p, body.schoolId, body.userId);
  }
}
