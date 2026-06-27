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
import { OperatorProvisioningService } from "./operator-provisioning.service";

const impSchema = z.object({ schoolId: z.string().uuid(), userId: z.string().uuid() });
const adminSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200).optional(),
  role: z.enum(["school_admin", "principal", "head_admin", "hr_manager"]).optional(),
});
const provisionSchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(2).max(40),
  plan: z.enum([PLANS.BASIC, PLANS.STANDARD, PLANS.ENTERPRISE]).optional(),
  admin: adminSchema,
});
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
  constructor(
    private readonly operator: OperatorService,
    private readonly provisioning: OperatorProvisioningService,
  ) {}

  /** Self-serve onboard a NEW school + its first admin (step-up: creates creds). */
  @Post("tenants")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  @RequireStepUp()
  provision(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(provisionSchema)) body: z.infer<typeof provisionSchema>,
  ) {
    return this.provisioning.provisionSchool(p, body);
  }

  /** Add another admin user to an existing school (step-up: creates creds). */
  @Post("tenants/:schoolId/admins")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  @RequireStepUp()
  addAdmin(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Body(new ZodValidationPipe(adminSchema)) body: z.infer<typeof adminSchema>,
  ) {
    return this.provisioning.createAdmin(p, schoolId, body);
  }

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
