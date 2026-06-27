import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import type { SubscriptionDto, TenantDto } from "@sms/types";
import { z } from "zod";
import { OPERATOR_PERMISSIONS, PLANS, SUBSCRIPTION_STATUS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { OperatorService } from "./operator.service";

const impSchema = z.object({ schoolId: z.string().uuid(), userId: z.string().uuid() });
const subSchema = z.object({
  plan: z.enum([PLANS.BASIC, PLANS.STANDARD, PLANS.ENTERPRISE]),
  overrides: z
    .object({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    })
    .optional(),
  // super_admin comp/grant: force a status and/or extend the paid period.
  status: z.enum([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.CANCELED]).optional(),
  currentPeriodEnd: z.string().datetime().nullable().optional(),
});

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

  // --- subscription / module entitlements (super_admin) -------------------
  @Get("tenants/:schoolId/subscription")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  getSubscription(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<SubscriptionDto> {
    return this.operator.getSubscription(p, schoolId);
  }

  @Put("tenants/:schoolId/subscription")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  setSubscription(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(subSchema)) body: z.infer<typeof subSchema>,
  ): Promise<SubscriptionDto> {
    return this.operator.setSubscription(p, schoolId, body);
  }
}
