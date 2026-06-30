import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import type { OperatorStudentDto, OperatorUserDto, PlatformAnalyticsDto, SubscriptionDto, TenantDto } from "@sms/types";
import { z } from "zod";
import { OPERATOR_PERMISSIONS, PLANS, SUBSCRIPTION_STATUS } from "@sms/types";
import { RequirePermission } from "../auth/require-permission.decorator";
import { RequireStepUp } from "../auth/require-stepup.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { Principal } from "../integrity/integrity.foundation";
import { OperatorService } from "./operator.service";
import { OperatorProvisioningService } from "./operator-provisioning.service";
import { OperatorUserService } from "./operator-user.service";
import { PlatformAnalyticsService } from "./platform-analytics.service";

const impSchema = z.object({ schoolId: z.string().uuid(), userId: z.string().uuid() });
const adminSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200).optional(),
  role: z.enum(["school_admin", "principal", "head_admin", "hr_manager"]).optional(),
});
const provisionSchema = z
  .object({
    name: z.string().min(1).max(160),
    slug: z.string().min(2).max(40),
    plan: z.enum([PLANS.BASIC, PLANS.STANDARD, PLANS.ENTERPRISE]).optional(),
    // Extra modules beyond the chosen plan: `enabled` force-on add-ons (the "special
    // modules" a school pays extra for); `disabled` force-off. Same shape as the
    // subscription PUT, so onboarding and later edits share one override model.
    overrides: z
      .object({
        enabled: z.array(z.string()).optional(),
        disabled: z.array(z.string()).optional(),
      })
      .optional(),
    // Onboarding seeds the founding admin tier — typically a school_admin AND a
    // principal. `admin` (single) is accepted for back-compat.
    admin: adminSchema.optional(),
    admins: z.array(adminSchema).min(1).max(6).optional(),
  })
  .refine((v) => Boolean(v.admin) || (v.admins && v.admins.length > 0), {
    message: "at least one admin is required",
  });
const statusSchema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) });
const requiredSchema = z.object({ required: z.boolean() });
const onboardingStatusSchema = z.object({
  status: z.enum(["NEW", "REVIEWING", "APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
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
    private readonly users: OperatorUserService,
    private readonly analyticsSvc: PlatformAnalyticsService,
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

  /** Platform-owner business dashboard: cross-tenant schools/revenue/plan metrics. */
  @Get("analytics")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  async analytics(@CurrentPrincipal() p: Principal): Promise<PlatformAnalyticsDto> {
    const result = await this.analyticsSvc.overview(p);
    await this.analyticsSvc.auditView(p);
    return result;
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

  // --- public onboarding-request review (super_admin) ------------------------
  @Get("onboarding-requests")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  onboardingRequests(@CurrentPrincipal() p: Principal) {
    return this.provisioning.listOnboardingRequests(p);
  }

  @Post("onboarding-requests/:id/status")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  setOnboardingStatus(
    @CurrentPrincipal() p: Principal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(onboardingStatusSchema)) body: z.infer<typeof onboardingStatusSchema>,
  ) {
    return this.provisioning.setOnboardingRequestStatus(p, id, body.status, body.note);
  }

  /** Every enrolled student of a school (cross-tenant; audited). */
  @Get("tenants/:schoolId/students")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  listSchoolStudents(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<OperatorStudentDto[]> {
    return this.operator.listSchoolStudents(p, schoolId);
  }

  // --- cross-tenant user directory + governance (super_admin) ----------------
  @Get("tenants/:schoolId/users")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  listUsers(
    @CurrentPrincipal() _p: Principal,
    @Param("schoolId") schoolId: string,
  ): Promise<OperatorUserDto[]> {
    return this.users.listUsers(schoolId);
  }

  /** Suspend / reactivate an account (DISABLED blocks login). Step-up: destructive. */
  @Put("tenants/:schoolId/users/:userId/status")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  @RequireStepUp()
  setUserStatus(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.users.setStatus(p, schoolId, userId, body.status);
  }

  /** Clear a lockout (failed-login counters). */
  @Post("tenants/:schoolId/users/:userId/unlock")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  unlockUser(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
  ) {
    return this.users.unlock(p, schoolId, userId);
  }

  /** Issue a one-time temp password (shown once). Step-up: credential change. */
  @Post("tenants/:schoolId/users/:userId/reset-password")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  @RequireStepUp()
  resetUserPassword(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
  ) {
    return this.users.resetPassword(p, schoolId, userId);
  }

  /** Reset (disable) a user's TOTP MFA. Step-up: weakens an auth factor. */
  @Post("tenants/:schoolId/users/:userId/mfa/reset")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  @RequireStepUp()
  resetUserMfa(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
  ) {
    return this.users.resetMfa(p, schoolId, userId);
  }

  /** Mandate / release MFA enrolment for a single user. */
  @Put("tenants/:schoolId/users/:userId/mfa-required")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  setUserMfaRequired(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(requiredSchema)) body: z.infer<typeof requiredSchema>,
  ) {
    return this.users.setMfaRequired(p, schoolId, userId, body.required);
  }

  /** Mandate / release MFA for every user holding a role. */
  @Put("tenants/:schoolId/roles/:roleName/mfa-required")
  @RequirePermission(OPERATOR_PERMISSIONS.PLATFORM_OPERATE)
  setRoleMfaRequired(
    @CurrentPrincipal() p: Principal,
    @Param("schoolId") schoolId: string,
    @Param("roleName") roleName: string,
    @Body(new ZodValidationPipe(requiredSchema)) body: z.infer<typeof requiredSchema>,
  ) {
    return this.users.setRoleMfaRequired(p, schoolId, roleName, body.required);
  }
}
